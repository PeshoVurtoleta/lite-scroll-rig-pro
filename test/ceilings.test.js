/**
 * ceilings.test.js
 *
 * SR-06 committed allocation ceilings. The two hot bodies -- DOMScroller.render
 * and ScrollEngine._tick -- must allocate zero bytes per call in steady state.
 * measureAllocs (min-over-batches) gives a per-call assertion with a real zero;
 * an allocating-renderer control proves the gate can fail.
 *
 * Requires node --expose-gc (measureAllocs forces GC to settle). Skipped
 * otherwise, so the plain `test` run stays green and the `ceilings` / `test:gc`
 * runs enforce the budget.
 *
 * Run: node --expose-gc --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';

import { DOMScroller } from '../src/binders/DOMScroller.js';
import { ScrollEngine } from '../src/core/ScrollEngine.js';
import { fakeEl, fakeWin, fakePool, fakeInput, fakeSpring, noopBinder, makeCountingRO } from './fixtures.js';

const HAS_GC = typeof globalThis.gc === 'function';
const skip = HAS_GC ? false : 'needs node --expose-gc';

function makeScroller(n) {
    const els = new Array(n);
    for (let i = 0; i < n; i++) els[i] = fakeEl({ offsetTop: i * 300, offsetHeight: 200 });
    const ds = new DOMScroller(els, fakePool, { binder: noopBinder(), win: fakeWin(0, 800) });
    ds.resize(); // measure once; the render loop reads pre-measured bounds only
    return ds;
}

for (const n of [8, 64, 256]) {
    test('render() allocates 0 B/op at n=' + n, { skip }, () => {
        const ds = makeScroller(n);
        const y = 500;
        const result = measureAllocs(() => ds.render(y), { iterations: 400, batches: 8 });
        const report = checkAllocs(result, { maxBytesPerCall: 0 });
        assert.equal(report.verdict, 'pass',
            'render() at n=' + n + ' allocated ' + result.bytesPerCall + ' B/call');
    });
}

test('_tick() allocates 0 B/op in steady state over 10000 frames', { skip }, () => {
    const input = fakeInput(1000);
    const spring = fakeSpring(500);
    const zeroRenderer = { last: 0, render(v) { this.last = v; }, resize() {} };

    const engine = new ScrollEngine(null, {
        input, spring, raf: () => 1, cancelRaf: () => {}
    });
    engine.addRenderer(zeroRenderer);
    engine.isActive = true;

    let clock = 0;
    const step = () => { clock += 16; engine._tick(clock); };
    // 1250 * 8 = 10000 measured frames.
    const result = measureAllocs(step, { iterations: 1250, batches: 8 });
    const report = checkAllocs(result, { maxBytesPerCall: 0 });
    assert.equal(report.verdict, 'pass',
        '_tick() allocated ' + result.bytesPerCall + ' B/call');
});

test('x4096 engine create/addRenderer/destroy leaves no live observers, no heap creep', () => {
    // SR-03 retention proof. lite-leak ^1.9.0 is unpublished (registry max
    // 1.8.1), so this uses the sanctioned manual gc heap-delta probe instead:
    // a churn loop, then FakeRO liveTotal()===0 plus a bounded heap delta.
    const ROCtor = makeCountingRO();
    const CYCLES = 4096;

    const runCycle = () => {
        const engine = new ScrollEngine(null, {
            input: fakeInput(), spring: fakeSpring(), raf: () => 1, cancelRaf: () => {}
        });
        const el = fakeEl({ offsetTop: 0, offsetHeight: 100 });
        const ds = new DOMScroller([el], fakePool, {
            binder: noopBinder(), win: fakeWin(0, 800), observe: true, ResizeObserverCtor: ROCtor
        });
        engine.addRenderer(ds);
        engine.destroy();
    };

    const gcAvail = typeof globalThis.gc === 'function';

    // Warm up to steady state first: the JIT, inline caches, and hidden-class
    // shapes allocate once on the initial cycles. Measuring those as "growth"
    // would gate on warmup, not on a leak. Double-gc so pending finalizers run
    // and then their objects are reclaimed before each sample.
    for (let i = 0; i < 512; i++) runCycle();
    if (gcAvail) { globalThis.gc(); globalThis.gc(); }
    const before = gcAvail ? process.memoryUsage().heapUsed : 0;

    for (let i = 0; i < CYCLES; i++) runCycle();

    if (gcAvail) { globalThis.gc(); globalThis.gc(); }
    const after = gcAvail ? process.memoryUsage().heapUsed : 0;

    // Every observer opened in the loop must be disconnected by destroy().
    assert.equal(ROCtor.liveTotal(), 0, 'observers survived destroy across 4096 cycles');

    if (gcAvail) {
        const delta = after - before;
        assert.ok(delta <= 64 * 1024,
            'heap grew ' + delta + ' B across 4096 create/destroy cycles (budget 65536 B)');
    }
});

test('control: an allocating renderer trips the ceiling (> 0 B/op)', { skip }, () => {
    const input = fakeInput(1000);
    const spring = fakeSpring(500);
    const sink = [];
    const allocRenderer = { render() { sink.push(new Float64Array(8)); }, resize() {} };

    const engine = new ScrollEngine(null, {
        input, spring, raf: () => 1, cancelRaf: () => {}
    });
    engine.addRenderer(allocRenderer);
    engine.isActive = true;

    let clock = 0;
    const step = () => { clock += 16; engine._tick(clock); };
    const result = measureAllocs(step, { iterations: 400, batches: 8 });
    const report = checkAllocs(result, { maxBytesPerCall: 0 });

    assert.ok(result.bytesPerCall > 0, 'control must allocate; got ' + result.bytesPerCall);
    assert.equal(report.verdict, 'fail', 'the gate must flag the allocating control');
    sink.length = 0;
});
