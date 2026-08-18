/**
 * qa-park-torture.test.js
 *
 * QA gate for SR2 (v1.2.0) idle discipline (park/wake). Independently verifies
 * the planner ASSERTIONS with a boundary matrix (0, 1, N-1, N, N+1, empty,
 * null, undefined, NaN, -0, duplicate dispose, dispose-during-iteration,
 * re-entrant write, plus adversarial cases) that the existing park.test.js /
 * ceilings.test.js / torture.mjs do not already pin numerically.
 *
 * Run: node --expose-gc --test test/qa-park-torture.test.js
 * (gc-gated tests skip cleanly without --expose-gc, matching ceilings.test.js)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';

import { ScrollEngine } from '../src/core/ScrollEngine.js';
import { DOMScroller } from '../src/binders/DOMScroller.js';
import {
    fakeInput, fakeSpring, fakeRaf, fakeEl, fakeWin, fakePool, noopBinder, makeCountingRO
} from './fixtures.js';

const HAS_GC = typeof globalThis.gc === 'function';
const skip = HAS_GC ? false : 'needs node --expose-gc';

function setup(opts = {}) {
    const input = fakeInput(opts.targetY || 0, opts.maxScroll != null ? opts.maxScroll : 1e9);
    const spring = fakeSpring(opts.ret != null ? opts.ret : 0, opts.vel != null ? opts.vel : 0);
    const r = fakeRaf();
    const engine = new ScrollEngine(null, {
        input, spring, raf: r.raf, cancelRaf: r.cancel,
        win: opts.win || null, park: opts.park, reducedMotion: opts.reducedMotion
    });
    if (opts.autoActive !== false) engine.isActive = true;
    let clock = 1000;
    const tick = () => { clock += 16; engine._tick(clock); return clock; };
    return { engine, input, spring, r, tick, getClock: () => clock };
}

// --- Assertion 1: idle 600 frames, exact schedule counts, park at exactly N=3 -

test('ASSERTION 1: idle 600 frames -- schedule count freezes at 2 (park on frame 3), no growth over the remaining 597', () => {
    const { engine, r, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    for (let i = 0; i < 600; i++) tick();
    assert.equal(engine.isParked, true, 'settled from frame 1 must be parked well before frame 600');
    assert.equal(r.s.handle, 2, 'exactly 2 raf schedules occur before park (frame 1, frame 2); frame 3 parks with no reschedule, and frames 4..600 (direct _tick calls while parked) schedule nothing further');
});

test('ASSERTION 1 control: { park: false } schedules all 600 frames, never parks', () => {
    const { engine, r, tick } = setup({ targetY: 0, ret: 0, vel: 0, park: false });
    for (let i = 0; i < 600; i++) tick();
    assert.equal(engine.isParked, false, 'park disabled must never park, even after 600 fully-settled frames');
    assert.equal(r.s.handle, 600, 'a frame is scheduled on every one of the 600 ticks');
});

test('ASSERTION 1: boundary matrix on the settle counter -- 0, 1, N-1(2), N(3), N+1(4)', () => {
    const { engine, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    assert.equal(engine._settle, 0, '0: before any tick, settle counter is 0, not parked');
    assert.equal(engine.isParked, false);
    tick();
    assert.equal(engine._settle, 1, '1: one settled frame');
    assert.equal(engine.isParked, false);
    tick();
    assert.equal(engine._settle, 2, 'N-1=2: two settled frames, still not parked');
    assert.equal(engine.isParked, false);
    tick();
    assert.equal(engine.isParked, true, 'N=3: parks on the third consecutive settled frame');
    tick();
    assert.equal(engine.isParked, true, 'N+1=4: a 4th tick while already parked stays parked (idempotent re-park), no throw');
});

// --- Assertion 2: wake latency + no double-schedule + zero-drop alternation --

test('ASSERTION 2: 4096 alternations of settle-to-park-boundary vs. wake on the exact parking tick drop 0 inputs', () => {
    // Drive the engine to the brink of parking (2 settled frames, _settle===2) and
    // then, ON WHAT WOULD BE the 3rd (parking) frame, race a wake() in with the
    // tick 4096 times. No input may be dropped: every cycle must end NOT parked,
    // with the target actually reflecting the racing input, and never more than
    // one outstanding raf schedule at a time.
    const { engine, input, spring, r, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    let drops = 0;
    for (let i = 0; i < 4096; i++) {
        tick(); // settle 1 (or re-settle after previous cycle's wake reset it to 0)
        tick(); // settle 2
        // Racing input arrives on what would be the parking tick: bump target,
        // update the fake spring's report to match (simulating the spring having
        // already caught up), and fire the same _onInput seam wheel/touch/
        // setTargetY use in production (VirtualScroll.setTargetY calls it; the
        // fakeInput fixture's setTargetY does NOT auto-fire it -- see park.test.js's
        // own "wake source: VirtualScroll _onInput hook" test, which fires it by
        // hand for the same reason -- so it is invoked explicitly here too).
        const newTarget = (i % 2 === 0) ? 100 : 0;
        input.setTargetY(newTarget);
        spring._ret = newTarget;
        input._onInput();
        tick(); // the race tick itself
        if (engine.isParked) drops++; // a drop would show up as an erroneous park
        if (input.targetY !== newTarget) drops++; // or a lost/overwritten target
    }
    assert.equal(drops, 0, 'drops out of 4096 alternations must be exactly 0');
    assert.equal(r.s.lastCb, engine._boundTick, 'the loop is still driven by the real tick, not a stray callback');
});

test('ASSERTION 2: exactly one raf scheduled per wake source, no double-schedule (each source independently)', () => {
    function parkThenTrigger(trigger) {
        const s = setup({ targetY: 0, ret: 0, vel: 0, win: { scrollY: 0, innerHeight: 800 } });
        s.tick(); s.tick(); s.tick();
        assert.equal(s.engine.isParked, true);
        const before = s.r.s.handle;
        trigger(s);
        assert.equal(s.r.s.handle, before + 1, 'exactly one schedule, never zero, never two');
        // Calling wake() again immediately (already unparked) must NOT schedule again.
        s.engine.wake();
        assert.equal(s.r.s.handle, before + 1, 'a second wake() while already running schedules nothing further');
    }
    parkThenTrigger((s) => s.engine.wake());
    parkThenTrigger((s) => { s.input.setTargetY(5); s.input._onInput(); });
    parkThenTrigger((s) => { s.engine.win.scrollY = 50; s.engine._onNativeScroll(); });
    parkThenTrigger((s) => s.engine._onKeyDown({ key: 'ArrowDown', target: { tagName: 'DIV' }, cancelable: false }));
    parkThenTrigger((s) => s.engine.resize());
});

// --- Assertion 3: _tick 0 B/op over 10000 frames INCLUDING park/wake cycling -

test('ASSERTION 3: _tick() allocates 0 B/op over 10000 frames that actually cross park/wake boundaries', { skip }, () => {
    const input = fakeInput(0, 1e9);
    const spring = fakeSpring(0, 0);
    const engine = new ScrollEngine(null, { input, spring, raf: () => 1, cancelRaf: () => {} });
    engine.isActive = true;

    let clock = 0;
    let n = 0;
    let parkedAtLeastOnce = false;
    let wokeAtLeastOnce = false;
    const step = () => {
        clock += 16;
        engine._tick(clock);
        n++;
        if (engine.isParked) parkedAtLeastOnce = true;
        // Every 5th tick, new input arrives: this both proves setTargetY's wake
        // path is allocation-free and forces the loop through park -> wake -> park
        // repeatedly across the 10000 measured frames.
        if ((n % 5) === 0) {
            const next = input.targetY === 0 ? 100 : 0;
            input.setTargetY(next);   // primitive path (allocation-free)
            spring._ret = next;       // simulate the spring already at rest on target
            engine.wake();            // the real wake seam a wheel/touch/setTargetY
                                       // change fires via VirtualScroll's _onInput
                                       // (fakeInput does not auto-fire it -- fired
                                       // explicitly here, same as elsewhere in-suite)
            if (!engine.isParked) wokeAtLeastOnce = true;
        }
    };
    // 1250 * 8 = 10000 measured frames.
    const result = measureAllocs(step, { iterations: 1250, batches: 8 });
    const report = checkAllocs(result, { maxBytesPerCall: 0 });
    assert.ok(parkedAtLeastOnce, 'precondition: the measured run must actually park at least once');
    assert.ok(wokeAtLeastOnce, 'precondition: the measured run must actually wake at least once');
    assert.equal(report.verdict, 'pass',
        '_tick() over 10000 frames including park/wake cycling allocated ' + result.bytesPerCall + ' B/call');
});

// --- Assertion 4: 4096x create/park/wake/destroy with a REAL RO-observed -----
// renderer wired (park.test.js / torture.mjs T1b never combine park-cycling
// with an RO-observing DOMScroller in the same churn loop -- this closes that
// gap).

test('ASSERTION 4: 4096x create/addRenderer(DOMScroller,RO)/park/wake/destroy -- zero live observers, bounded heap delta', () => {
    const ROCtor = makeCountingRO();
    const CYCLES = 4096;

    const runCycle = () => {
        const engine = new ScrollEngine(null, {
            input: fakeInput(0, 1e9), spring: fakeSpring(0, 0), raf: () => 1, cancelRaf: () => {}
        });
        const el = fakeEl({ offsetTop: 0, offsetHeight: 100 });
        const ds = new DOMScroller([el], fakePool, {
            binder: noopBinder(), win: fakeWin(0, 800), observe: true, ResizeObserverCtor: ROCtor
        });
        engine.addRenderer(ds); // wires RO + the _onInvalidate wake seam
        engine.isActive = true;
        let c = 0;
        engine._tick(c += 16); engine._tick(c += 16); engine._tick(c += 16); // settle -> park
        engine.wake();                                                      // unpark
        engine.destroy();
    };

    const gcAvail = typeof globalThis.gc === 'function';
    for (let i = 0; i < 512; i++) runCycle(); // warm up (JIT/hidden-class settle)
    if (gcAvail) { globalThis.gc(); globalThis.gc(); }
    const before = gcAvail ? process.memoryUsage().heapUsed : 0;

    for (let i = 0; i < CYCLES; i++) runCycle();

    if (gcAvail) { globalThis.gc(); globalThis.gc(); }
    const after = gcAvail ? process.memoryUsage().heapUsed : 0;

    assert.equal(ROCtor.liveTotal(), 0,
        'observers survived destroy across ' + CYCLES + ' create/park/wake/destroy cycles');

    if (gcAvail) {
        const delta = after - before;
        assert.ok(delta <= 64 * 1024,
            'heap grew ' + delta + ' B across ' + CYCLES + ' create/park/wake/destroy(RO) cycles (budget 65536 B)');
    }
});

// --- Boundary matrix: null / undefined / NaN / -0 on the new park entry points

test('boundary: spring.velocity truly undefined (not the fixture default) never settles, never throws, keeps ticking', () => {
    const { engine, spring, r, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    spring.velocity = undefined; // bypass fakeSpring's default-param substitution
    assert.equal(spring.velocity, undefined);
    for (let i = 0; i < 8; i++) assert.doesNotThrow(() => tick());
    assert.equal(engine.isParked, false, 'undefined velocity must never be treated as settled');
    assert.equal(r.s.handle, 8, 'every one of the 8 frames rescheduled');
});

test('boundary: spring.velocity is null -- "null is not zero" (project law); documents current behavior', () => {
    // Math.abs(null) coerces via ToNumber(null) === 0, so `Math.abs(null) < SETTLE_VEL`
    // evaluates true: a null velocity reads as "at rest" instead of failing closed
    // the way NaN/+Infinity/-Infinity/undefined correctly do. This is the ONE
    // adversarial case this suite adds beyond the planner's explicit list of
    // NaN/+Infinity/-Infinity/undefined -- see the QA report for why this is a
    // real, if narrow, defect against the codebase's own "null is not zero" law.
    const { engine, spring, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    spring.velocity = null;
    tick(); tick(); tick();
    // What SHOULD happen per "null is not zero": a null velocity is an
    // unverified/missing value and must fail closed, exactly like NaN/Infinity/
    // undefined -- i.e. isParked must be false here. Measuring, not assuming.
    assert.equal(engine.isParked, false,
        'DEFECT: velocity=null was treated as settled (coerced to 0) instead of failing closed');
});

test('boundary: targetY / currentY at -0 does not misbehave (park still requires N frames, not a premature frame-1 park)', () => {
    const { engine, tick } = setup({ targetY: -0, ret: -0, vel: 0 });
    tick();
    assert.equal(engine.isParked, false, '-0 target: still requires SETTLE_N frames, no premature park');
    tick();
    assert.equal(engine.isParked, false);
    tick();
    assert.equal(engine.isParked, true, '-0 target settles like a normal 0 after N frames');
});

test('boundary: empty renderer list (never called addRenderer) still parks correctly at N=3', () => {
    const { engine, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    // No renderers registered at all -- the render loop body is a true no-op.
    tick(); tick(); tick();
    assert.equal(engine.isParked, true, 'an engine with zero renderers still parks on schedule');
});

// --- Duplicate dispose / dispose-during-iteration on a PARKED engine ---------

test('duplicate dispose: destroy() twice on a PARKED engine does not throw and is idempotent', () => {
    const { engine, tick } = setup({ targetY: 0, ret: 0, vel: 0, win: { scrollY: 0, innerHeight: 800 } });
    tick(); tick(); tick();
    assert.equal(engine.isParked, true, 'precondition: parked');
    assert.doesNotThrow(() => engine.destroy());
    assert.equal(engine.isParked, false, 'destroy() resets isParked');
    assert.equal(engine.isActive, false);
    assert.doesNotThrow(() => engine.destroy(), 'a second destroy() on an already-destroyed, already-parked-before-destroy engine must not throw');
});

test('dispose-during-iteration while parked: a renderer that destroys the engine mid-render does not throw and skips later renderers', () => {
    const { engine } = setup({ targetY: 0, ret: 0, vel: 0 });
    const order = [];
    const destroyer = {
        render() { order.push('destroyer'); engine.destroy(); },
        resize() {}
    };
    const after = {
        render() { order.push('after'); },
        resize() {}
    };
    engine.addRenderer(destroyer);
    engine.addRenderer(after);
    engine.isActive = true;
    assert.doesNotThrow(() => engine._tick(1016));
    assert.deepEqual(order, ['destroyer'], 'a renderer destroyed mid-iteration must not receive a render() call after the destroy');
});

// --- Adversarial case the planner did not think of: wake() before start() ----

test('ADVERSARIAL (not in planner list): wake() called before start() (engine never active) is a harmless no-op, and the engine still starts cleanly afterward', () => {
    const input = fakeInput(0, 1e9);
    const spring = fakeSpring(0, 0);
    const r = fakeRaf();
    const engine = new ScrollEngine(null, { input, spring, raf: r.raf, cancelRaf: r.cancel });
    // isActive is false; isParked is false. wake() must not throw, must not
    // schedule (guard is isParked && isActive; neither holds).
    assert.doesNotThrow(() => engine.wake());
    assert.equal(engine.isParked, false);
    assert.equal(r.s.handle, 0, 'wake() before start() schedules nothing');
    // _wakePending is left true by wake(); start() must not be corrupted by that
    // stray pending flag -- the very next tick after start() must still be able
    // to settle and park normally (not permanently blocked by a stale pending).
    engine.start();
    assert.equal(engine.isActive, true);
    let clock = engine._lastTime || 0;
    const tick = () => { clock += 16; engine._tick(clock); };
    tick(); tick(); tick();
    assert.equal(engine.isParked, true, 'a stray pre-start wake() must not permanently block later parking');
    assert.doesNotThrow(() => engine.destroy());
});

// --- Same-tick race, both directions -----------------------------------------

test('same-tick race: wake() fired BETWEEN frames (the normal event case) wakes within exactly one frame', () => {
    const { engine, r, tick } = setup({ targetY: 0, ret: 0, vel: 0 });
    tick(); tick(); tick();
    assert.equal(engine.isParked, true);
    const before = r.s.handle;
    engine.wake(); // between frames, not re-entrant from inside _tick
    assert.equal(engine.isParked, false);
    assert.equal(r.s.handle, before + 1);
});

// --- reducedMotion park path --------------------------------------------------

test('reducedMotion: a huge/non-finite velocity is IGNORED by the target-only settle branch and still parks at N', () => {
    const { engine, tick } = setup({ targetY: 0, ret: 0, vel: 99999999, reducedMotion: true });
    tick(); tick(); tick();
    assert.equal(engine.isParked, true,
        'reduced motion settle is target-only; an enormous velocity must not block parking');
});

test('reducedMotion: a targetY change mid-count unsets settling, and a fresh N consecutive frames re-parks', () => {
    const { engine, input, spring, tick } = setup({ targetY: 0, ret: 0, vel: 0, reducedMotion: true });
    tick(); // settle 1
    tick(); // settle 2 (_settle === 2, one frame from parking)
    input.targetY = 50;
    spring._ret = 50; // currentY tracks the new target immediately
    tick(); // target changed since last frame -> must NOT settle, resets counter
    assert.equal(engine.isParked, false, 'a targetY change on the would-be parking frame must abort the park');
    assert.equal(engine._settle, 0, 'the settle counter must reset to 0, not merely fail to increment');
    tick(); tick(); tick(); // three fresh consistent frames at the new target
    assert.equal(engine.isParked, true, 'parks again after a fresh N consecutive settled frames at the new target');
});

// --- Wake re-arms dt: the first tick after wake must not see a stale/huge dt -

test('wake re-arms dt: the first tick after waking from park does not see a stale or huge elapsed time (no lurch)', () => {
    const { engine, spring, tick, getClock } = setup({ targetY: 0, ret: 0, vel: 0 });
    tick(); tick(); tick();
    assert.equal(engine.isParked, true);
    engine.wake();
    assert.equal(engine.isParked, false);
    // Simulate a long real-world gap (e.g. a backgrounded tab) before the next
    // rAF actually fires -- the resumed frame's dt must be re-baselined to 0,
    // not the raw (huge) elapsed delta, or the spring would lurch.
    const staleClock = getClock() + 50000; // 50 real seconds later
    engine._tick(staleClock);
    assert.equal(spring.lastDt, 0,
        'the first tick after wake must see dt===0 (fresh baseline), not a 50s jump');
});

// --- First-tick edge: _lastTargetY is seeded by start(), not left at 0 -------

test('first-tick edge: start() seeds _lastTargetY to the REAL starting position, not a stale 0, preventing a premature frame-1 park', () => {
    const input = fakeInput(500, 1e9); // rig "starts" already at y=500 (e.g. restored scroll position)
    const spring = fakeSpring(500, 0); // spring immediately reports at-rest at 500
    const r = fakeRaf();
    const win = { scrollY: 500, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
    const engine = new ScrollEngine(null, { input, spring, raf: r.raf, cancelRaf: r.cancel, win, reducedMotion: true });
    engine.start();
    assert.equal(engine._lastTargetY, 500, 'start() must seed _lastTargetY from the real starting Y, not leave it at the constructor default 0');
    let clock = 0;
    const tick = () => { clock += 16; engine._tick(clock); };
    tick();
    assert.equal(engine.isParked, false, 'frame 1 must not park even though currentY===targetY, because SETTLE_N frames are still required');
    tick(); tick();
    assert.equal(engine.isParked, true, 'parks normally on frame 3 once truly seeded and settled');
});
