/**
 * MetricsCache.test.js
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MetricsCache } from '../src/spatial/MetricsCache.js';

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

test('measures absolute bounds from rects + scroll offset', () => {
    const cache = new MetricsCache([fakeEl(1000, 200)], fakeWin(0, 800));
    cache.measure();
    assert.equal(cache.bounds[0], 200);
    assert.equal(cache.bounds[1], 1200);
});

test('scrollY is folded into absoluteTop', () => {
    const cache = new MetricsCache([fakeEl(200, 200)], fakeWin(800, 800));
    cache.measure();
    assert.equal(cache.bounds[0], 200);
    assert.equal(cache.bounds[1], 1200);
});

test('packs multiple elements with stride 2', () => {
    const cache = new MetricsCache([fakeEl(1000, 200), fakeEl(2000, 100)], fakeWin(0, 800));
    cache.measure();
    assert.equal(cache.bounds.length, 4);
    assert.equal(cache.bounds[0], 200);
    assert.equal(cache.bounds[1], 1200);
    assert.equal(cache.bounds[2], 1200);
    assert.equal(cache.bounds[3], 2100);
});

test('re-measure reflects changed layout', () => {
    const rect = { top: 1000, height: 200 };
    const el = { getBoundingClientRect: () => rect };
    const cache = new MetricsCache([el], fakeWin(0, 800));
    cache.measure();
    assert.equal(cache.bounds[0], 200);

    rect.top = 1500;
    cache.measure();
    assert.equal(cache.bounds[0], 700);
    assert.equal(cache.bounds[1], 1700);
});

test('null elements are skipped without throwing', () => {
    const cache = new MetricsCache([null, fakeEl(1000, 200)], fakeWin(0, 800));
    assert.doesNotThrow(() => cache.measure());
    assert.equal(cache.bounds[2], 200);
    assert.equal(cache.bounds[3], 1200);
});

test('measure is a no-op without a window', () => {
    const cache = new MetricsCache([fakeEl(1000, 200)], null);
    assert.doesNotThrow(() => cache.measure());
    assert.equal(cache.bounds[0], 0);
});

test('observe attaches a ResizeObserver to every element', () => {
    const els = [fakeEl(1000, 200), fakeEl(2000, 100)];
    const cache = new MetricsCache(els, fakeWin(0, 800), { observe: true, ResizeObserverCtor: FakeRO });
    assert.ok(cache._ro instanceof FakeRO);
    assert.deepEqual(cache._ro.observed, els);
});

test('a ResizeObserver callback re-measures and fires onResize', () => {
    const rect = { top: 1000, height: 200 };
    const el = { getBoundingClientRect: () => rect };
    let resizeCalls = 0;
    const cache = new MetricsCache([el], fakeWin(0, 800), {
        observe: true, ResizeObserverCtor: FakeRO, onResize: () => { resizeCalls++; }
    });

    rect.top = 1500;      // element moved (e.g. image above it loaded)
    cache._ro.trigger();

    assert.equal(cache.bounds[0], 700); // auto re-measured
    assert.equal(resizeCalls, 1);
});

test('no observer is created when observe is false', () => {
    const cache = new MetricsCache([fakeEl(1000, 200)], fakeWin(0, 800));
    assert.equal(cache._ro, null);
});

test('destroy disconnects the observer', () => {
    const cache = new MetricsCache([fakeEl(1000, 200)], fakeWin(0, 800), { observe: true, ResizeObserverCtor: FakeRO });
    const ro = cache._ro;
    cache.destroy();
    assert.equal(ro.disconnected, true);
});
