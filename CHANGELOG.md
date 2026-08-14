# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.1.0]

Native scroll reconciliation and keyboard access, both entirely on the cold path.

### Added
- **Native scroll reconciliation (native wins).** `ScrollEngine` now binds a
  passive `scroll` listener to the window. Because the rig is transform-only (it
  never calls `window.scrollTo`), any native scroll is FOREIGN: the engine
  reconciles the input target to `window.scrollY` (native wins over the rig's
  in-flight value). A foreign jump of `200 px` or more also snaps the spring, so
  a scrollbar drag or an in-page anchor jump lands in one frame instead of easing
  across the whole page; smaller deltas let the spring chase. `VirtualScroll`
  gains `setTargetY(y)` -- a clamped, allocation-free absolute setter -- and a
  `_lastNativeY` baseline that is the self-vs-foreign seam for a future deferred
  `nativeSync`. See `decisions/0003-native-reconciliation.md`.
- **Keyboard scrolling (on by default).** A window `keydown` listener drives
  `ArrowUp`/`ArrowDown` (+/-40 px), `PageUp`/`PageDown` and `Space`/`Shift+Space`
  (+/-`0.9 * innerHeight`), `Home` (top), and `End` (`maxScroll`). Focus in an
  interactive control (`INPUT`, `TEXTAREA`, `SELECT`, `BUTTON`, or
  `contenteditable`) is suppressed -- the rig never steals those keys. The
  browser's own keyboard scroll is `preventDefault`-ed only when the rig owns the
  event target, so it cannot double-count on top of the rig's step. Opt out with
  `{ keyboard: false }` (native reconciliation stays on).
- `ScrollEngineOptions.keyboard` in the TypeScript definitions.
- `decisions/0003-native-reconciliation.md`.

### Changed
- `ScrollEngine.destroy()` now detaches the `scroll` and `keydown` window
  listeners before nulling the refs they close over, symmetric with the existing
  reduced-motion listener teardown.
- The torture gate (`test/torture.mjs`) gains a tier asserting 4096 combined
  scroll + keydown dispatches allocate 0 B/op; the hot bodies (`_tick`,
  `render`) are unchanged and still 0 B/op.

## [1.0.1]

Measurement integrity, ownership, and honest gates.

### Fixed
- **SR-01: untransformed measurement.** `MetricsCache.measure()` now sources each
  element's absolute top from the `offsetParent` chain (`offsetTop`) and its
  height from `offsetHeight` -- layout space, so a live CSS transform on an
  element no longer pollutes its bounds. A re-measure while animated (the opt-in
  `ResizeObserver` path) returns the same bounds as one taken before. The legacy
  `getBoundingClientRect` source is retained behind `options.measure === 'rect'`
  as a test-only control. Fails closed: a missing/non-finite `offsetHeight`, or a
  non-finite `offsetTop` anywhere in the chain, skips that element and leaves its
  prior bounds -- it never fabricates a zero.
- **SR-03: renderer ownership.** `ScrollEngine.destroy()` now calls
  `renderer.destroy?.()` on every renderer `addRenderer` received (symmetric with
  the `resize()` it calls on registration) before clearing the list, so a
  `DOMScroller`'s `ResizeObserver` and element references are released instead of
  leaked.
- **SR-04: live prefers-reduced-motion.** The `matchMedia` query object is kept
  live: a `change` to reduce snaps a mid-flight spring to the target so it stops
  easing immediately; a change back seeds the spring at the live `currentY` so
  smoothing resumes without a backward jump. The listener is detached in
  `destroy()`.
- **SR-06: fail-closed preset.** An unknown `preset` now throws a `RangeError`
  listing the valid preset names instead of silently falling back to `gentle`.
  The check is an own-property lookup, so inherited keys (`constructor`,
  `__proto__`, ...) are rejected rather than resolving to a NaN spring. An absent
  preset still defaults to `gentle`.

### Added
- **`VERSION` export** (`src/index.js`) -- the package version, string-synced to
  `package.json` and asserted equal by the release gate.
- **`test/torture.mjs` gate** (`npm run torture`, `node --expose-gc`) -- prints
  `ok` / exits 0 only if the zero-allocation and retention tiers hold; the
  `SCROLL_RIG_TORTURE_BREAK=1` control injects a retained allocation and must make
  it exit non-zero. A gate that cannot fail is decorative.
- Committed allocation ceilings (`test/ceilings.test.js`, run under `npm test`
  with `--expose-gc`): `DOMScroller.render()` at 0 B/op for element counts
  {8, 64, 256} and `ScrollEngine._tick()` at 0 B/op in steady state, each with an
  allocating control that proves the gate can fail; plus a 4096-cycle
  create/addRenderer/destroy retention probe (observer live-count zero and a
  bounded heap delta). `@zakkster/lite-leak ^1.9.0` is unpublished (registry max
  1.8.1), so the retention proof uses the sanctioned manual gc heap-delta probe.
- `npm run verify` (= `test` + `torture`) gates `prepublishOnly`.
- `decisions/` records: `0001-measurement.md`, `0002-ownership.md`.

## [1.0.0]

Initial release.

### Added
- `ScrollEngine` -- owns the input layer, a spring, and the animation frame loop.
  Spring-smoothed interpolation from the stepped `targetY` to a smoothed
  `currentY`, a clamped delta-time so a resumed background tab does not lurch,
  and a `prefers-reduced-motion` bypass that tracks input 1:1.
- `VirtualScroll` -- wheel normalization across `deltaMode` (pixel / line / page)
  and pinch-safe touch panning via `@zakkster/lite-gesture`, producing a single
  clamped `targetY`.
- `DOMScroller` -- allocation-free render loop mapping scroll progress to four
  keyframe tracks (`[translateX, translateY, scale, rotateZ]`) and batching
  `matrix3d` writes through `@zakkster/lite-dom-binder`.
- `MetricsCache` -- pre-measured intersection bounds with an opt-in
  `ResizeObserver` that re-measures on element size changes, not just window
  resizes.
- `composeMatrix2D` and the spatial helpers (`writeIntersectionBounds`,
  `calculateIntersectionBounds`, `computeProgress`, `computeParallaxOffset`).
- Full TypeScript definitions and a headless `node:test` suite covering every
  module with injected fakes.
