# 0004 - Park when settled, wake on input

Status: accepted
Session: SR2 (v1.2.0)
Finding: SR-05

## Context

The rig markets itself for hours-long sessions (kiosks, overlays, embedded
Twitch panels) and for not perturbing the frame budget. Before this session
`ScrollEngine._tick` rescheduled a `requestAnimationFrame` unconditionally, so a
rig sitting on a settled spring with zero input still woke ~60 times a second
forever -- burning battery and a frame slot to compute the same transform. The
on-brand behavior is to sleep when there is nothing to do and wake the instant
there is.

The hard constraint: the frame loop is a zero-allocation hot body that has been
byte-frozen since v1.0.0. Idle discipline may add only field reads, a compare, a
counter, and one branch to `_tick`; everything else (the `wake()`/`_park()`
methods, the input hooks, all wake wiring) lives on the cold path.

## Decision

### Settle test: epsilon, velocity, and N

A frame is *settled* when the on-screen value has reached the target AND the
spring is at rest:

```
settled = Math.abs(currentY - targetY) < SETTLE_EPS_PX
       && (reducedMotion ? targetY === _lastTargetY
                         : Math.abs(spring.velocity) < SETTLE_VEL)
```

- `SETTLE_EPS_PX = 0.05` -- a twentieth of a pixel. Sub-pixel enough that a
  parked rig is visually identical to a running one, but far above float noise so
  a genuinely-arrived spring is recognized as arrived rather than chasing a
  rounding error forever.
- `SETTLE_VEL = 0.5` px/s -- position alone is not rest: a spring can pass
  through the target at speed. Requiring velocity below half a pixel per second
  means the spring is not about to move the value back out of the epsilon band on
  the next frame. In reduced motion there is no spring, so rest is simply the
  target holding still across two frames (`targetY === _lastTargetY`).
- `SETTLE_N = 3` consecutive settled frames before parking. One settled frame is
  not proof of rest (see above); three frames (~50 ms at 60 Hz) is long enough to
  reject a transient and short enough that the wasted wake-ups before parking are
  negligible.

### Fail closed on a non-finite velocity

A non-finite or absent velocity is an unverified physics state and must never
read as rest. The velocity is read into a local `v` and gated on
`Number.isFinite(v)` before the magnitude compare:

```
const v = this.spring.velocity;
... Number.isFinite(v) && Math.abs(v) < SETTLE_VEL
```

`Number.isFinite` rejects the entire unverified set -- `NaN`, `+Infinity`,
`-Infinity`, `undefined`, AND `null`. The `Number.isFinite` gate is load-bearing
for `null` specifically: `Math.abs(null)` coerces to `0`, so a bare
`Math.abs(null) < SETTLE_VEL` would read as settled and park the loop -- the
"null is not zero" law violation. With the explicit finiteness check every
non-finite/absent velocity fails closed and the loop keeps running rather than
parking on a spring it cannot vouch for. Finite numbers behave exactly as before.

### Destroyed-mid-tick guard

A renderer may synchronously call `engine.destroy()` from inside its
`render(currentY)` -- a legitimate SPA unmount driven by scroll position.
`destroy()` nulls `this.spring` and tears down the rAF and listeners. `_tick`
therefore checks `if (!this.spring) return;` immediately after the subscriber
loop and BEFORE the settle computation: it prevents both a null dereference on
`this.spring.velocity` and a post-destroy reschedule (the loop is already dead,
so it must not queue another frame). `this.spring` is nulled only by `destroy()`,
so it is a reliable torn-down sentinel. One field read plus a branch, no
allocation -- the hot body stays 0 B/op.

### `park` option, default on; `isParked` exposed

Parking is on by default (`{ park: false }` keeps the loop always running, for a
HUD that wants a live frame counter or a caller that drives its own reasons to
render). `isParked` is a public boolean for a HUD indicator.

### The same-tick input-vs-park race

The subtle case: input arrives the same frame the loop decides to park. Because
input events fire before the rAF callback within a frame, a wake landing just
before `_tick` already resets the settle counter, so the tick sees a fresh count
and does not park. But a wake can also land *inside* the tick (a renderer that
wakes from `render()`). The guard: `_tick` clears `_wakePending` at the top; any
`wake()` during that tick re-sets it; and the park condition requires
`!_wakePending`. So a mid-tick wake aborts that tick's park. `wake()` also zeroes
the settle counter, so both mechanisms cover the race -- no input is ever
dropped, and the loop stays live.

### Wake sources

`wake()` is called from every input that can change what should be on screen:

- wheel / touch / `setTargetY` -- `VirtualScroll` calls a null-guarded
  `this._onInput()` after any `targetY` change; the engine wires `_onInput` to its
  bound `wake()` at construction.
- native scroll reconciliation (`_onNativeScroll`) and keyboard (`_onKeyDown`) --
  call `wake()` directly.
- `resize()` and `addRenderer()` (when it reseeds a renderer's layout) -- new
  geometry must render even if the loop had parked.
- `ResizeObserver` invalidation -- `DOMScroller._invalidate` calls an optional
  `_onInvalidate` seam the engine wires to `wake()` in `addRenderer`, so a late
  image load that re-measures bounds wakes the loop.

`wake()` only schedules a frame when the loop is actually parked and the engine
is active, and only ever a single frame -- never a double schedule. Wake latency
is therefore at most one frame from every source.

### `_park()` is not a cancel

When `_tick` decides to park it simply does not reschedule; the rAF that was
executing is already consumed, so there is nothing pending to cancel. `_park()`
sets `isParked` and zeroes `_rafHandle`. Teardown (`destroy()`) resets `isParked`
so a parked engine that is destroyed cannot be re-woken.

## Proof

- `test/park.test.js`: idle parks after `SETTLE_N`; a moving spring never parks;
  `{ park: false }` never parks; non-finite velocity (`NaN`/`+/-Infinity`) never
  settles; reduced motion parks on a stationary target and wakes on a move; wake
  latency is exactly one frame from every source (direct, `_onInput`, native
  scroll, keyboard, resize, RO invalidation); the same-tick wake aborts the park.
- `test/ceilings.test.js` + `test/torture.mjs` (T1b): a park/wake cycle allocates
  0 B/op and `_tick`/`render` stay 0 B/op; a 4096x create/park/wake/destroy churn
  holds a bounded heap delta.
