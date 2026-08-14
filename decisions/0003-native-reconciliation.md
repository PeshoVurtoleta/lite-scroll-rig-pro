# 0003 - Native scroll reconciliation and keyboard

Status: accepted
Session: SR1 (v1.1.0)

## Context

The rig drives motion with CSS transforms only; it never calls
`window.scrollTo`. The native scroll position therefore stays where the document
puts it while the rig animates a separate `currentY`. Two real inputs move the
native position out from under the rig and, before this session, were dropped on
the floor:

1. A scrollbar drag or an in-page anchor jump (`#section`, `scrollIntoView`)
   moves `window.scrollY`. The rig kept easing toward its own stale `targetY`, so
   the page fought the user.
2. Keyboard scrolling (arrows, PageUp/PageDown, Space, Home, End) either did
   nothing (the rig ate wheel/touch but ignored keys) or, if the browser scrolled
   natively, moved the native position while the rig ignored it -- inaccessible
   either way.

Both are cold, event-driven inputs. The hard constraint is that neither may add
a single byte to the hot bodies (`ScrollEngine._tick`, `DOMScroller.render`):
the frame loop stays exactly as it was, all new work lives in bound listeners.

## Decision

### Native wins

A passive `scroll` listener on the window reconciles the input target to
`window.scrollY`. When the native position and the rig's in-flight value
disagree, the native position wins -- it is what the user or the platform
actually asked for, and it is the value the browser will report to assistive
tech. The reconciler writes through `VirtualScroll.setTargetY(y)`, a clamped
absolute setter added this session (distinct from `_clampAndApply`, which is the
relative accumulator wheel/touch use).

### 200 px snap threshold

A foreign delta of `NATIVE_SNAP_PX = 200` or more also snaps the spring to the
reconciled target. Rationale: a jump that large is a discrete navigation (anchor
jump, scrollbar throw, End key), not a scroll gesture -- easing a spring across
hundreds of pixels reads as the page lagging, so it lands in one frame. Below the
threshold the spring keeps chasing, so a small scrollbar nudge still feels
smooth. The threshold is a delta from the last reconciled position, not from
`currentY`, so it measures how far the native position moved, not how far behind
the spring happens to be.

### Self-vs-foreign seam (deferred nativeSync)

`VirtualScroll._lastNativeY` records the last native position the reconciler
acted on. Today, because the rig never scrolls natively, every scroll event is
foreign and this field only advances from the reconciler itself; a scroll whose
`scrollY` equals `_lastNativeY` is a redundant re-dispatch and is skipped. The
field exists as the seam for a future deferred `nativeSync` -- if the rig ever
writes the native position back (to keep the scrollbar honest), the scroll event
that write provokes would land at `_lastNativeY` and must be ignored as SELF, not
reconciled as FOREIGN (which would feed the rig its own output and deadlock).
Building the seam now keeps that future change a one-site edit.

### Keyboard in core, on by default, suppressible

`keydown` is bound in the engine (not left to the caller) and ON by default,
because a smooth-scroll rig that swallows the wheel but drops the keyboard is
inaccessible by construction. Steps: arrows +/-40 px (matching the wheel line
step), PageUp/PageDown and Space/Shift+Space +/-`0.9 * innerHeight`, Home to 0,
End to `maxScroll`. Focus in an interactive control (INPUT, TEXTAREA, SELECT,
BUTTON, contenteditable) suppresses the rig entirely -- those keys belong to the
control. `{ keyboard: false }` detaches only the keydown listener; native scroll
reconciliation stays on.

## RISK / mitigation

Listening for keydown on the window risks double-counting: if the rig steps
`targetY` AND the browser also scrolls natively, the ensuing native scroll event
reconciles on top of the rig's step. Mitigation is to `preventDefault` the
browser's native scroll -- but ONLY when the rig owns the event target
(`_ownsEvent`: a window-scoped rig owns the whole page; an element-scoped rig
owns only its own subtree). A nested scroller the rig does not manage keeps its
native keys; we suppress, never hijack, outside the rig target. This is why the
handler suppresses-and-returns for interactive elements rather than
preventDefaulting them.

## Teardown

`destroy()` removes both window listeners (scroll, keydown) before nulling the
refs they close over, symmetric with the existing reduced-motion MQL teardown
(decisions/0002). Everything (win, listeners, matchMedia) stays injectable, so
the whole path runs under headless node:test with a fake window that counts its
listeners and can emit synthetic scroll/key events.

## Proof

- `test/reconcile.test.js`: scrollY 0->4200 reconciles in one dispatch
  (`targetY === 4200`, spring snapped); a 40 px delta reconciles but does NOT
  snap; an unlistened control leaves `targetY === 0`.
- `test/keyboard.test.js`: each key produces its exact step; every interactive
  tag and contenteditable leaves `targetY` unchanged; the same key with
  suppression off moves it (control); `keyboard: false` attaches no keydown
  listener; destroy detaches both listeners (count back to 0).
- `test/ceilings.test.js` + `test/torture.mjs`: 4096 combined scroll + keydown
  dispatches allocate 0 B/op, and `_tick` / `render` stay 0 B/op -- the hot
  bodies are byte-for-byte unchanged.
