# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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
