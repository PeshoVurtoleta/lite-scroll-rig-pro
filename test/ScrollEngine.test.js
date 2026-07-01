/**
 * ScrollEngine.test.js
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScrollEngine } from '../src/core/ScrollEngine.js';

function fakeInput(targetY = 0) {
    return { targetY, maxSet: null, destroyed: false, setMaxScroll(m) { this.maxSet = m; }, destroy() { this.destroyed = true; } };
}

// Fake spring: update() returns a sentinel distinct from target, proving the
// engine forwards the spring's output (not the raw target) to renderers.
function fakeSpring(ret = 999) {
    return {
        target: 0, _ret: ret, updateCalls: 0, lastDt: -1, snapped: null,
        snap(v) { this.snapped = v; this.target = v; },
        update(dt) { this.updateCalls++; this.lastDt = dt; return this._ret; }
    };
}

function fakeRaf() {
    const s = { handle: 0, lastCb: null, cancelledWith: null };
    return {
        raf: (cb) => { s.lastCb = cb; return ++s.handle; },
        cancel: (h) => { s.cancelledWith = h; },
        s
    };
}

function makeRenderer() {
    return { rendered: [], resizes: 0, render(y) { this.rendered.push(y); }, resize() { this.resizes++; } };
}

function makeEngine(opts = {}) {
    const input = opts.input || fakeInput(opts.targetY || 0);
    const spring = opts.spring || fakeSpring(opts.springRet != null ? opts.springRet : 999);
    const r = fakeRaf();
    const engine = new ScrollEngine(null, {
        input, spring, raf: r.raf, cancelRaf: r.cancel, win: opts.win || null,
        reducedMotion: opts.reducedMotion, getMaxScroll: opts.getMaxScroll, maxDeltaTime: opts.maxDeltaTime
    });
    return { engine, input, spring, raf: r };
}

test('spring output (not raw target) is the interpolated currentY', () => {
    const { engine, input, spring } = makeEngine({ springRet: 999 });
    input.targetY = 500;
    engine.isActive = true;

    engine._tick(1000); // seeds lastTime; dt = 0
    engine._tick(1016); // dt = 0.016

    assert.equal(spring.target, 500);        // spring chases the jumpy target
    assert.equal(engine.currentY, 999);      // renderers get the spring value
    assert.ok(Math.abs(spring.lastDt - 0.016) < 1e-9);
    assert.equal(spring.updateCalls, 2);
});

test('dt is clamped so a resumed background tab does not lurch', () => {
    const { engine, spring } = makeEngine({ maxDeltaTime: 0.05 });
    engine.isActive = true;
    engine._tick(1000);   // seed
    engine._tick(6000);   // 5s gap -> clamp to 0.05
    assert.equal(spring.lastDt, 0.05);
});

test('prefers-reduced-motion bypasses the spring (1:1 tracking)', () => {
    const { engine, input, spring } = makeEngine({ reducedMotion: true, springRet: 999 });
    input.targetY = 500;
    engine.isActive = true;

    engine._tick(1000);
    assert.equal(engine.currentY, 500);  // targetY, not the spring sentinel
    assert.equal(spring.updateCalls, 0); // spring never consulted
});

test('render broadcasts currentY to every renderer', () => {
    const { engine } = makeEngine({ springRet: 42 });
    const a = makeRenderer();
    const b = makeRenderer();
    engine.addRenderer(a);
    engine.addRenderer(b);
    engine.isActive = true;

    engine._tick(1000);
    assert.deepEqual(a.rendered, [42]);
    assert.deepEqual(b.rendered, [42]);
});

test('addRenderer seeds an initial resize', () => {
    const { engine } = makeEngine();
    const r = makeRenderer();
    engine.addRenderer(r);
    assert.equal(r.resizes, 1);
});

test('resize uses getMaxScroll override when provided', () => {
    const { engine, input } = makeEngine({ getMaxScroll: () => 2200 });
    const r = makeRenderer();
    engine.addRenderer(r);
    engine.resize();
    assert.equal(input.maxSet, 2200);
    assert.equal(r.resizes, 2); // once on add, once on resize
});

test('resize default derives maxScroll from documentElement', () => {
    const win = { innerHeight: 800, scrollY: 0, document: { documentElement: { scrollHeight: 3000 } } };
    const { engine, input } = makeEngine({ win });
    engine.resize();
    assert.equal(input.maxSet, 2200); // 3000 - 800
});

test('start snaps the spring and seeds currentY from scroll position', () => {
    const win = { innerHeight: 800, scrollY: 150, document: { documentElement: { scrollHeight: 3000 } } };
    const { engine, input, spring, raf } = makeEngine({ win });
    engine.start();

    assert.equal(engine.isActive, true);
    assert.equal(engine.currentY, 150);
    assert.equal(input.targetY, 150);
    assert.equal(spring.snapped, 150);
    assert.ok(raf.s.lastCb, 'a frame was scheduled');
});

test('start is idempotent', () => {
    const { engine, raf } = makeEngine({ win: { innerHeight: 800, scrollY: 0, document: { documentElement: { scrollHeight: 1000 } } } });
    engine.start();
    const firstHandle = raf.s.handle;
    engine.start();
    assert.equal(raf.s.handle, firstHandle); // no second schedule
});

test('destroy stops the loop, clears renderers, tears down input', () => {
    const { engine, input, raf } = makeEngine({ win: { innerHeight: 800, scrollY: 0, document: { documentElement: { scrollHeight: 1000 } } } });
    const r = makeRenderer();
    engine.addRenderer(r);
    engine.start();
    const handle = raf.s.handle;
    engine.destroy();

    assert.equal(engine.isActive, false);
    assert.equal(raf.s.cancelledWith, handle);
    assert.equal(input.destroyed, true);
    assert.equal(engine.input, null);
});

test('native requestAnimationFrame is bound to the global (guards Illegal invocation)', () => {
    // Simulate a native rAF that records its receiver. Without binding, calling
    // it off `this._raf` would pass the engine instance as `this`, which real
    // browsers reject with "Illegal invocation".
    const savedRaf = globalThis.requestAnimationFrame;
    const savedCaf = globalThis.cancelAnimationFrame;
    let calledThis = null;
    globalThis.requestAnimationFrame = function (cb) { calledThis = this; return 7; };
    globalThis.cancelAnimationFrame = function () {};
    try {
        // No raf injected and no win -> the native fallback must bind to the global.
        const engine = new ScrollEngine(null, { input: fakeInput(), spring: fakeSpring() });
        engine.start();
        assert.equal(calledThis, globalThis);
    } finally {
        if (savedRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = savedRaf;
        if (savedCaf === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = savedCaf;
    }
});
