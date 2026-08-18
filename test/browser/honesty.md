# Browser lane -- what it proves, and what it does not

The node suite proves the rig's math and lifecycle against injected fakes. The
browser lane exists to prove the one thing fakes cannot: that the real rig,
loaded as ES modules and driven by real trusted input in a real Chromium, writes
the transforms the math says it should, and allocates nothing while doing it.

The lane is **opt-in and never gates publish**. It is not in `test`, `verify`, or
`prepublishOnly`; those stay node-only so a release never depends on Chromium.
Run it with `npm run lane` (oracle) and `npm run lane:alloc` (allocation).

## How the real rig loads

No bundler. `scenarios.mjs` serves the package from disk through the runner's
route seam: a generated `index.html` carries an import map pointing every bare
ecosystem specifier (`@zakkster/lite-spring`, `-gesture`, `-keyframe`,
`-dom-binder`, `-lerp`) at its entry file under `/pkg/node_modules/...`, and
`/app.js` imports the real `/pkg/src/index.js`. Nested bare imports (spring ->
lite-lerp) resolve through the same map. Chromium runs the actual shipped source.

## oracle.test.mjs -- transforms vs headless math

Each scenario drives **trusted** CDP input -- `Input.dispatchMouseEvent`
(`mouseWheel`), `dispatchKeyEvent`, `dispatchTouchEvent` -- the only kind the
rig's listeners honor (synthetic `.dispatchEvent` would not preventDefault or
drive the GestureTracker). After settling, it reads each element's
`style.transform` (the `matrix3d(...)` the real DOMBinder wrote), parses the 16
components, and compares them to `composeMatrix2D` recomputed in node from the
**same src exports** at the rig's reported `currentY` and the rig's own measured
bounds. The keyframe pool is defined identically in-page and in the oracle, so a
divergence is a real bug, not reimplementation drift. Tolerance is 0.02
(Float32 + CSSOM serialization). Teeth: every scenario asserts `currentY`
advanced and at least one section left identity, so a no-op run fails.

## SR-01 in vivo

`ro-remeasure` re-measures both a shipped DOMScroller (offsetTop source) and a
control DOMScroller built with `{ measure: 'rect' }` (the v1.0.0 gBCR source)
while a transform is live on the elements. The offsetTop bounds must not drift
(`<= 0.5px`); the gBCR control must drift (`>= 5px`) because gBCR returns the
transformed box. This is the SR-01 fix proven in a real browser, with the failing
v1.0.0 behavior kept as the control that still drifts.

## alloc.cdp.mjs -- the frame loop at the floor, in the real DOM

A ~10k-frame scripted wheel scroll with CDP `HeapProfiler` sampling around the
burst. The gated signal is `renderPath`: sampled self-size of the rig's hot
frames (`_tick`, `render`, `composeMatrix2D`, `updateDOMTransforms`). The honest
path stays under the floor; a control run with a per-frame allocating renderer
must exceed it by a clear margin, or the gate is declared toothless and fails.
Whole-page `total` is logged but not gated (page/GC noise).

## Fail-closed posture

Missing Chromium is a **failure**, not a skip -- unless `LITE_NO_BROWSER=1`, which
skips the lane loudly (the node lanes still gate). A `/pkg` path that cannot be
read returns no body, so Chromium 404s the module and the lane fails loudly
rather than testing an empty page.

## What the lane does NOT cover

- It does not assert 60fps or wall-clock frame timing; headless rAF cadence is
  not the production cadence. The claim is allocation and correctness, not speed.
- Touch rubber-band / native-pan-suppression is exercised through the real
  GestureTracker pan path, but the platform's own overscroll physics are not
  asserted numerically -- only that the pan drives `currentY`.
- The park/wake idle claim is proven in the node lane (0 rAF wake-ups after
  settle, wake <= 1 frame); the browser lane does not re-assert rAF counts.
