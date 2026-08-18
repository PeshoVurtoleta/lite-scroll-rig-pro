// test/browser/control.v100.mjs
//
// CONTROL -- NOT SHIPPED. The v1.0.0 measurement source, reproduced so the
// browser oracle has teeth for SR-01. v1.0.0 measured an element's absolute top
// with getBoundingClientRect: `absoluteTop = rect.top + scrollY`. Because gBCR
// returns the TRANSFORMED box, re-measuring an element the rig is animating
// (translate/scale live) bakes the current transform into the bounds -- the
// silent, self-reinforcing geometry bug the 1.0.1 offsetTop-chain source fixed.
//
// In the lane a second DOMScroller constructed with { measure: 'rect' } exercises
// exactly this path in the real browser. The oracle asserts that, after a live
// transform, its re-measured bounds DRIFT while the shipped offsetTop source
// stays put -- proving the fix is real and the harness could catch a regression.

// v1.0.0 absolute-top formula. Pure; used to document the control and to assert
// the drift direction in the oracle.
export function v100AbsoluteTop(rectTop, scrollY) {
    return rectTop + (scrollY || 0);
}

// Largest absolute per-slot change between two bounds arrays (enterY/exitY pairs).
export function maxAbsDelta(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
        return Infinity; // fail closed: mismatched shapes are not "no drift"
    }
    let max = 0;
    for (let i = 0; i < before.length; i++) {
        const d = Math.abs(before[i] - after[i]);
        if (d > max) max = d;
    }
    return max;
}
