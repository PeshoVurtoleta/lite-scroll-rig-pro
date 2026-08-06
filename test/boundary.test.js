/**
 * boundary.test.js
 *
 * QA pass boundary coverage that the SR0 stages left thin: the zero-element
 * case. An empty elements array must be a clean no-op end to end --
 * construction, measure()/render(), and destroy() -- for both MetricsCache
 * and DOMScroller. Parallel in spirit to the offsetHeight/offsetTop skip
 * tests in measurement.test.js: each assertion states an exact expected
 * value or an explicit doesNotThrow, so it can actually fail.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MetricsCache } from '../src/spatial/MetricsCache.js';
import { DOMScroller } from '../src/binders/DOMScroller.js';
import { fakeWin, fakePool, fakeBinder, FakeRO } from './fixtures.js';

test('MetricsCache with an empty elements array: count 0, measure() and destroy() are clean no-ops', () => {
    const cache = new MetricsCache([], fakeWin(0, 800));
    assert.equal(cache.count, 0);
    assert.equal(cache.bounds.length, 0);
    assert.doesNotThrow(() => cache.measure());
    assert.equal(cache.bounds.length, 0); // still nothing to write
    assert.doesNotThrow(() => cache.destroy());
});

test('MetricsCache with observe:true and an empty array attaches an observer that observes nothing', () => {
    const cache = new MetricsCache([], fakeWin(0, 800), { observe: true, ResizeObserverCtor: FakeRO });
    assert.ok(cache._ro instanceof FakeRO);
    assert.equal(cache._ro.observed.length, 0);
    assert.doesNotThrow(() => cache.destroy());
});

test('DOMScroller with an empty elements array: count 0, render() and destroy() are clean no-ops', () => {
    const binder = fakeBinder();
    const ds = new DOMScroller([], fakePool, { binder, win: fakeWin(0, 800) });
    assert.equal(ds.count, 0);
    assert.equal(ds.matrices.length, 0);

    assert.doesNotThrow(() => ds.render(500));
    assert.equal(binder.updateCalls, 1);      // still flushes once, an empty batch
    assert.equal(binder.lastCount, 0);
    assert.equal(binder.lastMatrices.length, 0);

    assert.doesNotThrow(() => ds.resize());
    assert.doesNotThrow(() => ds.destroy());
    assert.equal(binder.destroyed, true);
});
