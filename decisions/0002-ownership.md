# 0002 - Renderer ownership and teardown

Status: accepted
Session: SR0 (v1.0.1)
Finding: SR-03

## Context

ScrollEngine.addRenderer(renderer) registers a renderer and calls its resize()
once on registration to seed layout. v1.0.0's destroy() cleared the subscriber
array but never told the renderers to tear themselves down. A DOMScroller holds
a MetricsCache which may hold a live ResizeObserver and references to every
tracked element. Dropping the array without disconnecting those observers leaks
them: the engine is gone, the observers and element refs survive.

## Decision

The engine owns teardown of everything addRenderer received. destroy() calls
`renderer.destroy?.()` on each registered renderer before clearing the array.
This is symmetric with registration: addRenderer calls resize() on the way in,
destroy() calls destroy() on the way out. Ownership follows registration.

Order matters. destroy() detaches observers and listeners BEFORE dropping refs:

1. stop the frame loop (cancel rAF),
2. renderer.destroy?.() on each subscriber, then clear the array,
3. removeEventListener on the live reduced-motion MQL,
4. input.destroy(), then null out input, spring, and the MQL.

## Alternative considered

Caller-owned teardown: the engine clears its list, the caller destroys each
renderer it created. Rejected: it splits ownership. The caller handed the
renderer to the engine and the engine drove its lifecycle (resize on
registration, render every frame); the engine finishing that lifecycle on
destroy is the least surprising contract and the one that cannot leak by
omission at the call site.

## Proof

A retention test in test/ceilings.test.js runs 4096 cycles of engine create /
addRenderer(DOMScroller with a fake ResizeObserver) / destroy, then asserts the
observer factory's liveTotal() === 0 (every observer opened in the loop was
disconnected by the destroy cascade). Under node --expose-gc it also brackets
the loop with globalThis.gc() and asserts the heapUsed delta stays under 64 KiB,
so a per-cycle leak of engines, caches, or element refs would fail it; without
--expose-gc the heap assertion is skipped and only liveTotal is checked.

This uses the manual gc heap-delta probe rather than @zakkster/lite-leak: that
package's ^1.9.0 pin is unpublished (registry max 1.8.1), so the probe is the
sanctioned substitute for this session. v1.0.0 (which never called
renderer.destroy) is the failing control.
