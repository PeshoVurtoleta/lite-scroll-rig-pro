/**
 * park.test.js
 *
 * SR-05 idle discipline: the frame loop parks when the spring settles and wakes
 * on input, within one frame, from every source -- with the off switch, the
 * same-tick input-vs-park race, and the non-finite-velocity fail-closed path all
 * pinned. Everything is driven through injected fakes: a fakeSpring whose
 * settable velocity lets a test put the spring at rest or keep it moving, a
 * fakeRaf that records every schedule, and the real cold-path handlers.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScrollEngine } from '../src/core/ScrollEngine.js';
import { DOMScroller } from '../src/binders/DOMScroller.js';
import {
    fakeInput, fakeSpring, fakeRaf, fakeWin, fakePool, fakeEl, noopBinder, makeRenderer
} from './fixtures.js';

// Build an ACTIVE engine with an injected raf that records every schedule. The
// spring returns `ret` as currentY and reports `vel` as its velocity, so
// (ret === targetY, vel < SETTLE_VEL) is a settled frame.
function setup(opts = {}) {
    const input = fakeInput(opts.targetY || 0, opts.maxScroll != null ? opts.maxScroll : 1e9);
    const spring = fakeSpring(opts.ret != null ? opts.ret : 0, opts.vel != null ? opts.vel : 0);
    const r = fakeRaf();
    const engine = new ScrollEngine(null, {
        input, spring, raf: r.raf, cancelRaf: r.cancel,
        win: opts.win || null, park: opts.park, reducedMotion: opts.reducedMotion
    });
    engine.isActive = true;
    let clock = 1000;
    const tick = () => { clock += 16; engine._tick(clock); };
    return { engine, input, spring, r, tick };
}

test('an idle rig parks after SETTLE_N settled frames and stops scheduling', () => {
    const { engine, r, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    // Frame 1: _settle -> 1 (scheduled). Frame 2: -> 2 (scheduled). Frame 3: -> 3
    // >= SETTLE_N (3) -> park, no reschedule.
    tick();
    assert.equal(engine.isParked, false);
    tick();
    assert.equal(engine.isParked, false);
    const beforeThird = r.s.handle;
    tick();
    assert.equal(engine.isParked, true, 'parked on the 3rd consecutive settled frame');
    assert.equal(r.s.handle, beforeThird, 'the parking frame scheduled no successor');
});

test('a moving spring never parks (velocity above SETTLE_VEL keeps the loop live)', () => {
    // currentY === targetY (0) but velocity 5 >= SETTLE_VEL -> never settled.
    const { engine, r, tick } = setup({ targetY: 0, ret: 0, vel: 5 });
    for (let i = 0; i < 10; i++) tick();
    assert.equal(engine.isParked, false);
    assert.equal(r.s.handle, 10, 'every frame rescheduled');
});

test('off switch: { park: false } keeps the loop running forever even when settled', () => {
    const { engine, r, tick } = setup({ targetY: 0, ret: 0, vel: 0, park: false });
    for (let i = 0; i < 20; i++) tick();
    assert.equal(engine.isParked, false, 'park disabled -> never parks');
    assert.equal(r.s.handle, 20, 'a frame scheduled every tick');
});

test('non-finite velocity is never settled (fail closed), for NaN and Infinity', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
        const { engine, r, tick } = setup({ targetY: 0, ret: 0, vel: bad });
        for (let i = 0; i < 8; i++) tick();
        assert.equal(engine.isParked, false, 'velocity ' + bad + ' must not settle');
        assert.equal(r.s.handle, 8, 'velocity ' + bad + ' keeps rescheduling');
    }
});

test('reduced motion parks on a stationary target and wakes when it moves', () => {
    const { engine, input, r, tick } = setup({ targetY: 0, ret: 0, vel: 0, reducedMotion: true });
    // Reduced motion: settled means the target held across frames. Frame 1 sees
    // _lastTargetY = 0 (from constructor) vs targetY 0 -> settled; parks on frame 3.
    tick(); tick(); tick();
    assert.equal(engine.isParked, true);
    const parkedHandle = r.s.handle;
    // Target moves -> _onInput wakes it within one frame.
    input.targetY = 500;
    engine.wake();
    assert.equal(engine.isParked, false);
    assert.equal(r.s.handle, parkedHandle + 1, 'exactly one frame scheduled on wake');
});

// --- wake latency: <= 1 frame from each source ------------------------------

function parkThenTrigger(opts, trigger) {
    const s = setup(opts);
    s.tick(); s.tick(); s.tick();
    assert.equal(s.engine.isParked, true, 'precondition: engine parked');
    const before = s.r.s.handle;
    trigger(s);
    assert.equal(s.engine.isParked, false, 'source did not wake the engine');
    assert.equal(s.r.s.handle, before + 1, 'wake scheduled exactly one frame');
    assert.equal(s.r.s.lastCb, s.engine._boundTick, 'scheduled the tick, not something else');
}

test('wake source: direct wake()', () => {
    parkThenTrigger({ targetY: 0, ret: 0, vel: 0 }, (s) => s.engine.wake());
});

test('wake source: VirtualScroll _onInput hook (wheel/touch/setTargetY)', () => {
    // The engine wires input._onInput to its bound wake() at construction, so a
    // wheel/touch/setTargetY targetY change wakes a parked loop.
    parkThenTrigger({ targetY: 0, ret: 0, vel: 0 }, (s) => {
        assert.equal(typeof s.input._onInput, 'function', 'input._onInput was wired');
        s.input._onInput();
    });
});

test('wake source: native scroll reconciliation', () => {
    const win = { scrollY: 0, innerHeight: 800 };
    parkThenTrigger({ targetY: 0, ret: 0, vel: 0, win }, (s) => {
        win.scrollY = 120;
        s.engine._onNativeScroll();
    });
});

test('wake source: keyboard', () => {
    const win = { scrollY: 0, innerHeight: 800 };
    parkThenTrigger({ targetY: 0, ret: 0, vel: 0, win }, (s) => {
        s.engine._onKeyDown({ key: 'ArrowDown', target: { tagName: 'DIV' }, cancelable: false });
    });
});

test('wake source: resize', () => {
    parkThenTrigger({ targetY: 0, ret: 0, vel: 0 }, (s) => s.engine.resize());
});

test('wake source: ResizeObserver invalidation on a DOMScroller', () => {
    const s = setup({ targetY: 0, ret: 0, vel: 0 });
    const ds = new DOMScroller([fakeEl({ offsetTop: 0, offsetHeight: 100 })], fakePool, {
        binder: noopBinder(), win: fakeWin(0, 800)
    });
    s.engine.addRenderer(ds); // wires ds._onInvalidate -> engine wake
    assert.equal(typeof ds._onInvalidate, 'function', 'addRenderer wired the invalidate seam');
    s.tick(); s.tick(); s.tick();
    assert.equal(s.engine.isParked, true);
    const before = s.r.s.handle;
    ds._invalidate(); // simulate an RO firing on a late image load
    assert.equal(s.engine.isParked, false);
    assert.equal(s.r.s.handle, before + 1);
});

test('same-tick input-vs-park race: a wake() during the tick blocks that park', () => {
    // A renderer that wakes the engine from inside render() -- input landing the
    // same tick the loop would otherwise park. _tick clears _wakePending at the
    // top; the mid-tick wake re-sets it, and the !_wakePending guard aborts the
    // park. The engine must stay live and keep scheduling -- no input is dropped.
    const { engine, r, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    const waker = {
        render() { engine.wake(); },
        resize() {}
    };
    engine.addRenderer(waker);
    for (let i = 0; i < 10; i++) tick();
    assert.equal(engine.isParked, false, 'a same-tick wake must prevent parking');
    assert.equal(r.s.handle, 10, 'the loop kept scheduling; no frame was lost');
});

test('a renderer that never settles keeps the loop awake', () => {
    // currentY (ret 500) far from targetY (0): |500 - 0| >= SETTLE_EPS_PX.
    const { engine, r, tick } = setup({ targetY: 0, ret: 500, vel: 0 });
    const renderer = makeRenderer();
    engine.addRenderer(renderer);
    for (let i = 0; i < 12; i++) tick();
    assert.equal(engine.isParked, false);
    assert.equal(r.s.handle, 12);
});
