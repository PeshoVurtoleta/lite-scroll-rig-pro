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

test('destroy detaches the wheel listener and tears down the tracker', () => {
    const { vs, target } = makeVS();
    const tracker = vs._tracker;
    vs.destroy();

    assert.equal(vs.isActive, false);
    assert.equal(target.handler('wheel'), undefined);
    assert.equal(tracker.destroyed, true);
    assert.equal(vs._tracker, null);
});
