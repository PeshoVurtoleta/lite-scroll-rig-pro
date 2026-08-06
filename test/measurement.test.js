/**
 * measurement.test.js
 *
 * SR-01: measurement must survive a live transform. An element carrying
 * scale(0.85) translateY(120px) at measure time must still report its
 * UNTRANSFORMED layout bounds. The default offsetTop-chain source is
 * transform-immune; the legacy 'rect' source is not, and is asserted here as
 * the failing control that reproduces the v1.0.0 pollution.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MetricsCache } from '../src/spatial/MetricsCache.js';
import { fakeEl, fakeWin, FakeRO } from './fixtures.js';

// Layout truth: element offsetTop 200 inside a parent at offsetTop 800 -> the
// offsetTop chain sums to 1000; offsetHeight 200; viewport 800.
//   enterY = 1000 - 800 = 200
//   exitY  = 1000 + 200 = 1200
// The transform scale(0.85) translateY(120px) is baked ONLY into
// getBoundingClientRect (top 970, height 170) -- the offset* fields stay pure
// layout, exactly as a real browser reports them.
function scene() {
    const parent = fakeEl({ offsetTop: 800, offsetHeight: 1200, offsetParent: null });
    const el = fakeEl({
        offsetTop: 200,
        offsetHeight: 200,
        offsetParent: parent,
        rect: { top: 970, height: 170 } // scale(0.85)*1000 + 120 ; 200*0.85
    });
    return { el };
}

test('default source reports untransformed layout bounds under a live transform', () => {
    const { el } = scene();
    const cache = new MetricsCache([el], fakeWin(0, 800));
    cache.measure();
    assert.equal(cache.bounds[0], 200);
    assert.equal(cache.bounds[1], 1200);
});

test('an RO-triggered re-measure mid-animation returns the same bounds', () => {
    const { el } = scene();
    const cache = new MetricsCache([el], fakeWin(0, 800), {
        observe: true, ResizeObserverCtor: FakeRO
    });
    cache.measure(); // initial
    assert.equal(cache.bounds[0], 200);
    assert.equal(cache.bounds[1], 1200);

    // Mid-animation the transform is still live; the RO fires. offset* are
    // unchanged, so the re-measure must be identical -- no pollution creep.
    cache._ro.trigger();
    assert.equal(cache.bounds[0], 200);
    assert.equal(cache.bounds[1], 1200);
});

test('control: the legacy rect source is polluted by the transform (v1.0.0 bug)', () => {
    const { el } = scene();
    const cache = new MetricsCache([el], fakeWin(0, 800), { measure: 'rect' });
    cache.measure();
    // rect.top 970 -> enterY 170, NOT the true 200. The gate can fail.
    assert.notEqual(cache.bounds[0], 200);
});

test('fail closed: a missing offsetHeight leaves prior bounds, never fabricates', () => {
    const parent = fakeEl({ offsetTop: 800, offsetHeight: 1200 });
    const good = fakeEl({ offsetTop: 200, offsetHeight: 200, offsetParent: parent });
    const cache = new MetricsCache([good], fakeWin(0, 800));
    cache.measure();
    assert.equal(cache.bounds[0], 200);
    assert.equal(cache.bounds[1], 1200);

    // Drop the height: an unverified layout state. Skip, do not zero.
    good.offsetHeight = undefined;
    cache.measure();
    assert.equal(cache.bounds[0], 200);  // prior bounds preserved
    assert.equal(cache.bounds[1], 1200);
});

// --- boundary coverage: the offsetTop-chain source itself -------------------

test('fail closed: a non-finite offsetTop MID-CHAIN (not the element, not the root) leaves prior bounds, never fabricates', () => {
    // 3-level chain: el -> parent (finite) -> grandparent (mutable offsetTop).
    // grandparent starts finite so a real baseline can be established, then is
    // corrupted to isolate the mid-chain case from the "own offsetTop" and
    // "root offsetTop" variants already covered elsewhere.
    const grandparent = fakeEl({ offsetTop: 0, offsetHeight: 0, offsetParent: null });
    const parent = fakeEl({ offsetTop: 800, offsetHeight: 1200, offsetParent: grandparent });
    const el = fakeEl({ offsetTop: 200, offsetHeight: 200, offsetParent: parent });
    const cache = new MetricsCache([el], fakeWin(0, 800));

    cache.measure(); // baseline: 200 + 800 + 0 = 1000 -> enterY 200, exitY 1200
    assert.equal(cache.bounds[0], 200);
    assert.equal(cache.bounds[1], 1200);

    grandparent.offsetTop = NaN; // corrupt the middle of the chain
    cache.measure();
    assert.equal(cache.bounds[0], 200); // prior bounds preserved, not fabricated
    assert.equal(cache.bounds[1], 1200);
});

test('an element with offsetParent null immediately reduces to its own offsetTop, no throw', () => {
    // offsetTop 500 alone (no chain) against an 800px viewport: startY would be
    // 500 - 800 = -300, clamped to 0 by writeIntersectionBounds -- so a wrong
    // absoluteTop (e.g. one that walked a non-existent parent and added extra
    // px) would still show up in exitY, which is not clamped.
    const el = fakeEl({ offsetTop: 500, offsetHeight: 200, offsetParent: null });
    const cache = new MetricsCache([el], fakeWin(0, 800));
    assert.doesNotThrow(() => cache.measure());
    assert.equal(cache.bounds[0], 0);   // 500 - 800, clamped to >= 0
    assert.equal(cache.bounds[1], 700); // 500 + 200
});

test('a 4-level offsetParent chain sums every offsetTop exactly once', () => {
    const root = fakeEl({ offsetTop: 400, offsetHeight: 0, offsetParent: null });
    const mid2 = fakeEl({ offsetTop: 250, offsetHeight: 0, offsetParent: root });
    const mid1 = fakeEl({ offsetTop: 100, offsetHeight: 0, offsetParent: mid2 });
    const el = fakeEl({ offsetTop: 50, offsetHeight: 120, offsetParent: mid1 });
    const cache = new MetricsCache([el], fakeWin(0, 800));
    cache.measure();
    // 50 + 100 + 250 + 400 = 800 -> enterY 0, exitY 920. A skipped or
    // double-counted level moves both numbers, so this is falsifiable.
    assert.equal(cache.bounds[0], 0);
    assert.equal(cache.bounds[1], 920);
});

test('a null element in the array is skipped without throwing (default offsetTop-chain source)', () => {
    const parent = fakeEl({ offsetTop: 800, offsetHeight: 1200, offsetParent: null });
    const el = fakeEl({ offsetTop: 200, offsetHeight: 200, offsetParent: parent });
    const cache = new MetricsCache([null, el], fakeWin(0, 800));
    assert.doesNotThrow(() => cache.measure());
    assert.equal(cache.bounds[0], 0);   // null slot untouched (zero-init)
    assert.equal(cache.bounds[1], 0);
    assert.equal(cache.bounds[2], 200); // real element measured normally
    assert.equal(cache.bounds[3], 1200);
});
