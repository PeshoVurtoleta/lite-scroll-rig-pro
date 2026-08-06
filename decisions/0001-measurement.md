# 0001 - Untransformed measurement source

Status: accepted
Session: SR0 (v1.0.1)
Finding: SR-01

## Context

MetricsCache pre-measures each tracked element's absolute document-Y bounds so
the render loop never touches layout. v1.0.0 sourced the absolute top from
`getBoundingClientRect().top + scrollY`. getBoundingClientRect returns the
element's VISUAL box -- it includes any live CSS transform. The rig's own
renderer applies scale/translate transforms every frame, so if a re-measure
(window resize, or the opt-in ResizeObserver the README recommends) fires while
an element is mid-animation, the measured bounds absorb the current transform.
The next frame maps progress against corrupted bounds; the element jumps. The
ResizeObserver feature, sold as a robustness win, becomes a corruption vector.

## Decision

Source absolute top from the offsetTop chain: walk `offsetParent` summing
`offsetTop`, and take height from `offsetHeight`. These are LAYOUT-space
properties -- they report where the element sits in the document flow, before
any transform is composited. A transform on the element (or on a descendant)
never leaks in.

The legacy getBoundingClientRect path is kept behind `options.measure === 'rect'`
as a test-only control, so the pollution bug stays reproducible and the fix is
asserted against it.

`writeIntersectionBounds` and the intersection formula are untouched. Only the
source of `absoluteTop` and `height` changed. measure() stays read-only with
respect to layout and allocation-free.

## Alternatives considered

(b) Clear-measure-reapply: zero the binder's transforms, force one gBCR pass,
restore them. Rejected: it requires binder cooperation (the cache would have to
know how to neutralize whatever the renderer did), it makes measure() a
layout-WRITING operation, and it risks a visible flash. The offset chain needs
none of that.

## Known cost

offsetTop excludes transforms BY DEFINITION, which is exactly why it is
transform-immune -- but it also means a layout-affecting transform on an
ANCESTOR is out of scope: offsetTop reports untransformed layout position, so if
a real page transforms a container to reposition its children, that shift is not
reflected. This is an accepted, documented limitation. The rig transforms the
tracked elements themselves, not their layout ancestors, so it does not hit this
edge. locomotive-scroll converged on the same offsetTop-chain approach.

## Fail-closed note

A missing or non-finite offsetHeight is an unverified layout state. measure()
does NOT fabricate a zero (null is not zero) -- it skips the element and leaves
its prior bounds intact.
