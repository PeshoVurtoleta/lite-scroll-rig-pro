/**
 * VirtualScroll.test.js
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VirtualScroll } from '../src/core/VirtualScroll.js';

// Fake wheel target that records listeners so tests can fire events.
function makeTarget() {
    const listeners = [];
    return {
        style: {},
        addEventListener(type, fn) { listeners.push({ type, fn }); },
        removeEventListener(type, fn) {
            const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
            if (i >= 0) listeners.splice(i, 1);
        },
        handler(type) { const l = listeners.find((x) => x.type === type); return l ? l.fn : undefined; }
    };
}

// Injected gesture factory: captures handlers, never touches the DOM.
function fakeGesture(el, handlers) {
    return { el, handlers, destroyed: false, destroy() { this.destroyed = true; } };
}

function makeVS(opts = {}) {
    const target = makeTarget();
    const vs = new VirtualScroll(target, { createTracker: fakeGesture, maxScroll: 100000, ...opts });
    return { vs, target };
}

function wheel(deltaY, deltaMode = 0, cancelable = true) {
    let prevented = false;
    return {
        ev: { deltaY, deltaMode, cancelable, preventDefault() { prevented = true; } },
        wasPrevented: () => prevented
    };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('pixel-mode wheel applies the multiplier', () => {
    const { vs, target } = makeVS({ multiplier: 1.2 });
    target.handler('wheel')(wheel(100, 0).ev);
    assert.ok(near(vs.targetY, 120)); // 100 * 1.2
});

test('line-mode (deltaMode 1) scales by 40px', () => {
    const { vs, target } = makeVS({ multiplier: 1.2 });
    target.handler('wheel')(wheel(3, 1).ev);
    assert.ok(near(vs.targetY, 144)); // 3 * 40 * 1.2
});

test('page-mode (deltaMode 2) scales by 800px', () => {
    const { vs, target } = makeVS({ multiplier: 1.2 });
    target.handler('wheel')(wheel(1, 2).ev);
    assert.ok(near(vs.targetY, 960)); // 1 * 800 * 1.2
});

test('targetY clamps to [0, maxScroll]', () => {
    const { vs, target } = makeVS({ multiplier: 1, maxScroll: 50 });
    target.handler('wheel')(wheel(100, 0).ev);
    assert.equal(vs.targetY, 50);
    target.handler('wheel')(wheel(-500, 0).ev);
    assert.equal(vs.targetY, 0);
});

test('preventDefault is called only when the event is cancelable', () => {
    const { target } = makeVS();
    const a = wheel(10, 0, true);
    target.handler('wheel')(a.ev);
    assert.equal(a.wasPrevented(), true);

    const b = wheel(10, 0, false);
    target.handler('wheel')(b.ev);
    assert.equal(b.wasPrevented(), false);
});

test('an inactive instance ignores wheel input', () => {
    const { vs, target } = makeVS({ multiplier: 1 });
    vs.isActive = false;
    target.handler('wheel')(wheel(100, 0).ev);
    assert.equal(vs.targetY, 0);
});

test('pan gesture applies inverted, scaled frameDy', () => {
    const { vs } = makeVS({ touchMultiplier: 1.5 });
    const pan = vs._tracker.handlers.onPanMove;

    pan({ frameDy: -20 }); // -(-20) * 1.5 = +30
    assert.ok(near(vs.targetY, 30));

    pan({ frameDy: -10 }); // +15 -> 45
    assert.ok(near(vs.targetY, 45));

    pan({ frameDy: 20 });  // -30 -> 15
    assert.ok(near(vs.targetY, 15));
});

test('pan gesture is ignored while inactive', () => {
    const { vs } = makeVS({ touchMultiplier: 1.5 });
    vs.isActive = false;
    vs._tracker.handlers.onPanMove({ frameDy: -100 });
    assert.equal(vs.targetY, 0);
});

test('setMaxScroll re-clamps a now-out-of-range target', () => {
    const { vs } = makeVS();
    vs.targetY = 9999;
    vs.setMaxScroll(500);
    assert.equal(vs.targetY, 500);
});

test('setTargetY sets an absolute, clamped target', () => {
    const { vs } = makeVS({ maxScroll: 500 });
    vs.setTargetY(300);
    assert.equal(vs.targetY, 300);
    vs.setTargetY(9999);
    assert.equal(vs.targetY, 500, 'clamped to the ceiling');
    vs.setTargetY(-50);
    assert.equal(vs.targetY, 0, 'clamped to the floor');
});

test('setTargetY rejects NaN and leaves the prior target intact (null is not zero)', () => {
    const { vs } = makeVS({ maxScroll: 500 });
    vs.setTargetY(200);
    vs.setTargetY(NaN);
    assert.equal(vs.targetY, 200, 'a NaN input never fabricates a scroll to 0');
    vs.setTargetY(0 / 0);
    assert.equal(vs.targetY, 200);
});

// --- QA boundary pass: setTargetY's non-finite / non-numeric inputs. This is
//     a "new entry point" this session (decisions/0003) so the full matrix
//     applies: Infinity, -Infinity, a very large finite y, -0, null,
//     undefined. ---

test('setTargetY(+Infinity) clamps to maxScroll, never Infinity', () => {
    const { vs } = makeVS({ maxScroll: 500 });
    vs.setTargetY(Infinity);
    assert.equal(vs.targetY, 500);
    assert.ok(Number.isFinite(vs.targetY));
});

test('setTargetY(-Infinity) clamps to 0, never -Infinity', () => {
    const { vs } = makeVS({ maxScroll: 500 });
    vs.setTargetY(-Infinity);
    assert.equal(vs.targetY, 0);
    assert.ok(Number.isFinite(vs.targetY));
});

test('setTargetY(very large finite y) clamps to maxScroll', () => {
    const { vs } = makeVS({ maxScroll: 500 });
    vs.setTargetY(Number.MAX_SAFE_INTEGER);
    assert.equal(vs.targetY, 500);
});

test('setTargetY(-0) does not throw and settles at a value numerically == 0 (assert.strictEqual uses Object.is, so compare loosely)', () => {
    const { vs } = makeVS({ maxScroll: 500 });
    vs.setTargetY(200);
    assert.doesNotThrow(() => vs.setTargetY(-0));
    // -0 fails the -0<0 clamp check (false) the same way +0 does, so it is
    // never coerced to +0 by the clamp; assert numeric equality (== 0), not
    // Object.is identity, since node:assert/strict distinguishes -0 from 0.
    assert.ok(vs.targetY == 0, 'numerically the floor'); // eslint-disable-line eqeqeq
    assert.ok(Number.isFinite(vs.targetY));
});

// FAIL (real defect, reported to the coder -- not fixed here): the guard on
// line "if (y !== y) return;" only rejects NaN. null and undefined are NOT
// NaN by that check (null !== null -> false, undefined !== undefined ->
// false), so both fall through the relational clamp comparisons (which
// coerce null/undefined-vs-number comparisons to false) UNCHANGED, and are
// assigned directly to targetY as non-numeric values. This violates the
// project's fail-closed law ("null is not zero") and this same session's own
// planner assertion for setTargetY ("rejects NaN ... leaves targetY
// unchanged -- null is not zero"), which by construction must also reject
// null/undefined, not merely NaN.
test('FAIL-CLOSED (currently broken): setTargetY(null) must leave targetY unchanged, not become null', () => {
    const { vs } = makeVS({ maxScroll: 500 });
    vs.setTargetY(200);
    vs.setTargetY(null);
    assert.equal(vs.targetY, 200, 'a null input is unverified -> must be rejected, not assigned');
    assert.notEqual(vs.targetY, null);
});

test('FAIL-CLOSED (currently broken): setTargetY(undefined) must leave targetY unchanged, not become undefined', () => {
    const { vs } = makeVS({ maxScroll: 500 });
    vs.setTargetY(200);
    vs.setTargetY(undefined);
    assert.equal(vs.targetY, 200, 'an undefined input is unverified -> must be rejected, not assigned');
    assert.notEqual(vs.targetY, undefined);
});

test('destroy detaches the wheel listener and tears down the tracker', () => {
    const { vs, target } = makeVS();
    const tracker = vs._tracker;
    vs.destroy();

    assert.equal(vs.isActive, false);
    assert.equal(target.handler('wheel'), undefined);
    assert.equal(tracker.destroyed, true);
    assert.equal(vs._tracker, null);
});
