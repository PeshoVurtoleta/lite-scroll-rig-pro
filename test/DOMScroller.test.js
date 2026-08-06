/**
 * DOMScroller.test.js
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DOMScroller } from '../src/binders/DOMScroller.js';

// Deterministic pool: row R at time t evaluates to R + t.
const fakePool = { eval(row, t) { return row + t; } };

function fakeBinder() {
    return {
        invalidateCount: 0, updateCalls: 0, lastMatrices: null, lastCount: 0, destroyed: false,
        invalidate() { this.invalidateCount++; },
        updateDOMTransforms(els, m, c) { this.lastMatrices = m.slice(); this.lastCount = c; this.updateCalls++; },
        destroy() { this.destroyed = true; }
    };
}

function fakeEl(top, height) {
    return { getBoundingClientRect: () => ({ top, height }) };
}
function fakeWin(scrollY, innerHeight) {
    return { scrollY, innerHeight };
}

class FakeRO {
    constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = false; }
    observe(el) { this.observed.push(el); }
    disconnect() { this.disconnected = true; }
    trigger() { this.cb([]); }
}

const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

test('render maps progress -> keyframe tracks -> matrix at t=0.5', () => {
    const binder = fakeBinder();
    const ds = new DOMScroller([fakeEl(1000, 200)], fakePool, { binder, win: fakeWin(0, 800), measure: 'rect' });
    ds.resize(); // bounds: enter 200, exit 1200

    ds.render(700); // t = (700-200)/1000 = 0.5

    const m = binder.lastMatrices;
    assert.equal(binder.updateCalls, 1);
    assert.equal(binder.lastCount, 1);
    // tracks at t=0.5: tx=row0+0.5=0.5, ty=1.5, scale=2.5, rotZ=3.5
    assert.ok(near(m[12], 0.5)); // translateX
    assert.ok(near(m[13], 1.5)); // translateY
    assert.equal(m[14], 0);      // translateZ
    assert.equal(m[15], 1);
    // scale 2.5 with tiny rotation: m[0] = cos(3.5deg)*2.5
    assert.ok(near(m[0], Math.cos(3.5 * Math.PI / 180) * 2.5));
});

test('progress clamps below the enter bound and above the exit bound', () => {
    const binder = fakeBinder();
    const ds = new DOMScroller([fakeEl(1000, 200)], fakePool, { binder, win: fakeWin(0, 800), measure: 'rect' });
    ds.resize();

    ds.render(50);   // below enter -> t=0 -> tx = row0 + 0 = 0
    assert.ok(near(binder.lastMatrices[12], 0));

    ds.render(9000); // above exit -> t=1 -> tx = row0 + 1 = 1
    assert.ok(near(binder.lastMatrices[12], 1));
});

test('two entities are packed at 16-float strides', () => {
    const binder = fakeBinder();
    const ds = new DOMScroller([fakeEl(0, 800), fakeEl(2000, 200)], fakePool, { binder, win: fakeWin(0, 800), measure: 'rect' });
    ds.resize();
    ds.render(500);

    assert.equal(binder.lastCount, 2);
    assert.equal(binder.lastMatrices.length, 32);
    // entity 1 uses rows 4..7; translateX row = 4
    // (value depends on its own progress, but the buffer slot must exist)
    assert.equal(binder.lastMatrices[16 + 15], 1);
});

test('resize re-measures and invalidates the binder', () => {
    const binder = fakeBinder();
    const ds = new DOMScroller([fakeEl(1000, 200)], fakePool, { binder, win: fakeWin(0, 800), measure: 'rect' });
    const before = binder.invalidateCount;
    ds.resize();
    assert.ok(binder.invalidateCount > before);
    assert.equal(ds.cache.bounds[0], 200);
});

test('ResizeObserver triggering re-measures and invalidates', () => {
    const binder = fakeBinder();
    const el = fakeEl(1000, 200);
    const ds = new DOMScroller([el], fakePool, {
        binder, win: fakeWin(0, 800), observe: true, ResizeObserverCtor: FakeRO, measure: 'rect'
    });

    assert.ok(ds.cache._ro instanceof FakeRO);
    assert.deepEqual(ds.cache._ro.observed, [el]);

    const before = binder.invalidateCount;
    ds.cache._ro.trigger();
    assert.ok(binder.invalidateCount > before); // auto-invalidated on resize
});

test('destroy tears down the cache and binder', () => {
    const binder = fakeBinder();
    const ds = new DOMScroller([fakeEl(1000, 200)], fakePool, {
        binder, win: fakeWin(0, 800), observe: true, ResizeObserverCtor: FakeRO
    });
    const ro = ds.cache._ro;
    ds.destroy();

    assert.equal(binder.destroyed, true);
    assert.equal(ro.disconnected, true);
    assert.equal(ds.cache, null);
});
