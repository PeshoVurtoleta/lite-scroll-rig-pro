/**
 * @zakkster/lite-scroll-rig-pro -- torture gate.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Three tiers, run STRICTLY SEQUENTIALLY -- lite-gc-profiler is
 * one-measurement-at-a-time, never nested, never concurrent:
 *
 *     T0 alloc      DOMScroller.render() (n = 8/64/256) and ScrollEngine._tick()
 *                   at 0 B/op in steady state
 *     T1 retention  4096x engine create/addRenderer/destroy: zero live
 *                   ResizeObservers and a bounded heap delta (SR-03). lite-leak
 *                   ^1.9.0 is unpublished (registry max 1.8.1), so the retention
 *                   proof is the sanctioned manual gc heap-delta probe.
 *     T2 controls   the gate must be able to fail
 *
 * Control: SCROLL_RIG_TORTURE_BREAK=1 node --expose-gc test/torture.mjs injects a
 * retained allocation into the render hot loop; T0 must then trip and the gate
 * must exit non-zero. A gate that cannot fail is decorative.
 *
 * Peers (lite-gc-profiler) are devDependencies only; src/ carries no runtime
 * dependency beyond its ecosystem siblings.
 *
 * @license MIT
 */

import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';

import { DOMScroller } from '../src/binders/DOMScroller.js';
import { ScrollEngine } from '../src/core/ScrollEngine.js';
import {
    fakeEl, fakeWin, fakePool, fakeInput, fakeSpring, noopBinder, makeCountingRO
} from './fixtures.js';

const BREAK = process.env.SCROLL_RIG_TORTURE_BREAK === '1';

// Retained sink for the BREAK control's injected allocations -- module-scoped so
// the allocating binder's writes are rooted and cannot be optimized away.
const sink = [];

function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// --- T0: the two hot bodies allocate zero bytes per call --------------------
function allocatingBinder() {
    // Trips the ceiling: pushes a retained typed array on every frame.
    return { updateDOMTransforms() { sink.push(new Float64Array(8)); }, invalidate() {}, destroy() {} };
}

function makeScroller(n) {
    const els = new Array(n);
    for (let i = 0; i < n; i++) els[i] = fakeEl({ offsetTop: i * 300, offsetHeight: 200 });
    const binder = BREAK ? allocatingBinder() : noopBinder();
    const ds = new DOMScroller(els, fakePool, { binder, win: fakeWin(0, 800) });
    ds.resize(); // measure once; render() reads pre-measured bounds only
    return ds;
}

function t0Alloc() {
    for (const n of [8, 64, 256]) {
        const ds = makeScroller(n);
        const result = measureAllocs(() => ds.render(500), { iterations: 400, batches: 8 });
        if (checkAllocs(result, { maxBytesPerCall: 0 }).verdict !== 'pass') {
            die('T0 alloc: render() at n=' + n + ' allocated ' + result.bytesPerCall + ' B/call');
        }
    }

    const engine = new ScrollEngine(null, {
        input: fakeInput(1000), spring: fakeSpring(500), raf: () => 1, cancelRaf: () => {}
    });
    engine.addRenderer({ last: 0, render(v) { this.last = v; }, resize() {} });
    engine.isActive = true;
    let clock = 0;
    const result = measureAllocs(() => { clock += 16; engine._tick(clock); }, { iterations: 1250, batches: 8 });
    if (checkAllocs(result, { maxBytesPerCall: 0 }).verdict !== 'pass') {
        die('T0 alloc: _tick() allocated ' + result.bytesPerCall + ' B/call');
    }
    sink.length = 0;
}

// --- T1: create/addRenderer/destroy leaks no observers, no heap -------------
function t1Retention() {
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

    // Warm to steady state so one-time JIT / inline-cache / hidden-class cost is
    // not miscounted as growth; double-gc so finalizers run and reclaim first.
    for (let i = 0; i < 512; i++) runCycle();
    globalThis.gc(); globalThis.gc();
    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < CYCLES; i++) runCycle();

    globalThis.gc(); globalThis.gc();
    const after = process.memoryUsage().heapUsed;

    if (ROCtor.liveTotal() !== 0) {
        die('T1 retention: ' + ROCtor.liveTotal() + ' observers survived destroy across ' + CYCLES + ' cycles');
    }
    const delta = after - before;
    if (delta > 64 * 1024) {
        die('T1 retention: heap grew ' + delta + ' B across ' + CYCLES + ' cycles (budget 65536 B)');
    }
}

function main() {
    if (typeof globalThis.gc !== 'function') {
        die('run with --expose-gc:  node --expose-gc test/torture.mjs');
    }

    t0Alloc();
    t1Retention();

    // T2 control: with BREAK set, T0's allocating binder must already have tripped
    // the ceiling and exited non-zero. Reaching here means the gate could not fail.
    if (BREAK) {
        die('SCROLL_RIG_TORTURE_BREAK set but the gate still passed');
    }

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
