/**
 * lifecycle.test.js
 *
 * SR-04 (live reduced-motion), SR-03 (ownership teardown), SR-06 (fail-closed
 * preset). The reduced-motion query stays live: it flips mid-session, snaps a
 * mid-flight spring on enable, and detaches cleanly on destroy. destroy() owns
 * teardown of everything addRenderer received.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScrollEngine } from '../src/core/ScrollEngine.js';
import { DOMScroller } from '../src/binders/DOMScroller.js';
import {
    fakeInput, fakeSpring, fakeRaf, makeRenderer, makeMatchMedia,
    makeROFactory, fakeEl, fakeWin, fakePool, noopBinder
} from './fixtures.js';

function makeEngine(opts = {}) {
    const input = fakeInput(opts.targetY || 0);
    const spring = fakeSpring(999);
    const r = fakeRaf();
    const engine = new ScrollEngine(null, {
        input, spring, raf: r.raf, cancelRaf: r.cancel,
        matchMedia: opts.matchMedia, preset: opts.preset
    });
    return { engine, input, spring, raf: r };
}

test('reduced-motion enable flips the flag live and snaps the spring to target', () => {
    const mm = makeMatchMedia(false);
    const { engine, input, spring } = makeEngine({ matchMedia: mm });
    input.targetY = 640;
    assert.equal(engine._reducedMotion, false);

    mm.mql.emit(true);
    assert.equal(engine._reducedMotion, true);
    assert.equal(spring.snapped, 640); // a mid-flight spring stops easing
});

test('reduced-motion disable resumes smoothing from the live position (no backward jump)', () => {
    const mm = makeMatchMedia(true);
    const { engine, spring } = makeEngine({ matchMedia: mm });
    assert.equal(engine._reducedMotion, true);

    engine.currentY = 512; // the live on-screen position while reduced motion was on

    mm.mql.emit(false);
    assert.equal(engine._reducedMotion, false);
    assert.equal(spring.snapped, 512); // seeded at currentY, not a frozen enable-moment value

    engine.isActive = true;
    const before = spring.updateCalls;
    engine._tick(1000);
    engine._tick(1016);
    assert.ok(spring.updateCalls > before); // spring is back in the loop
});

test('destroy detaches the MQL listener; a later emit is an inert no-op', () => {
    const mm = makeMatchMedia(false);
    const { engine } = makeEngine({ matchMedia: mm });
    assert.equal(mm.mql.listenerCount(), 1);

    engine.destroy();
    assert.equal(mm.mql.listenerCount(), 0);
    assert.doesNotThrow(() => mm.mql.emit(true)); // no listener -> no throw
    assert.equal(engine._reducedMotion, false);   // and no flip
});

test('a boolean reducedMotion forces the value and attaches no listener', () => {
    const mm = makeMatchMedia(false);
    const input = fakeInput();
    const engine = new ScrollEngine(null, {
        input, spring: fakeSpring(), reducedMotion: true, matchMedia: mm
    });
    assert.equal(engine._reducedMotion, true);
    assert.equal(engine._mql, null);
    assert.equal(mm.mql.listenerCount(), 0);
});

test('an unknown spring preset fails closed with a RangeError listing valid names', () => {
    assert.throws(
        () => new ScrollEngine(null, { input: fakeInput(), spring: fakeSpring(), preset: 'ludicrous' }),
        (err) => err instanceof RangeError
            && /ludicrous/.test(err.message)
            && /gentle/.test(err.message)
    );
});

test('an absent preset defaults to gentle without throwing', () => {
    assert.doesNotThrow(() => new ScrollEngine(null, { input: fakeInput(), spring: fakeSpring() }));
});

test('an inherited key ("constructor") is rejected, not resolved to a NaN spring', () => {
    for (const evil of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
        assert.throws(
            () => new ScrollEngine(null, { input: fakeInput(), spring: fakeSpring(), preset: evil }),
            (err) => err instanceof RangeError,
            'preset "' + evil + '" must fail closed'
        );
    }
});

test('destroy tears down every registered renderer (ownership, SR-03)', () => {
    const { engine } = makeEngine();
    const a = makeRenderer();
    const b = makeRenderer();
    engine.addRenderer(a);
    engine.addRenderer(b);

    engine.destroy();
    assert.equal(a.destroyed, true);
    assert.equal(b.destroyed, true);
    assert.equal(engine.input, null);
    assert.equal(engine.spring, null);
});

test('ScrollEngine.destroy() is idempotent: a second call does not throw', () => {
    const { engine } = makeEngine();
    const r = makeRenderer();
    engine.addRenderer(r);
    engine.destroy();
    assert.doesNotThrow(() => engine.destroy());
    assert.equal(engine.input, null);
    assert.equal(engine.spring, null);
});

test('DOMScroller.destroy() is idempotent: a second call does not throw', () => {
    const el = fakeEl({ offsetTop: 0, offsetHeight: 100 });
    const ds = new DOMScroller([el], fakePool, { binder: noopBinder(), win: fakeWin(0, 800) });
    ds.destroy();
    assert.doesNotThrow(() => ds.destroy());
});

// Adversarial case (not called out by the planner): a renderer that tears the
// engine down FROM INSIDE its own render(), mid-_tick -- e.g. a renderer that
// unmounts and calls engine.destroy() synchronously. The subscriber loop reads
// `subs.length` live on every iteration, so the destroy-triggered truncation
// (subs.length = 0) must stop the loop before any later renderer fires, and
// _tick must not throw walking off a truncated array.
test('re-entrant destroy() from inside a renderer.render() call does not throw and skips later renderers', () => {
    const { engine } = makeEngine();
    let bCalls = 0;
    const rendererA = { render() { engine.destroy(); }, resize() {} }; // destroys engine mid-loop
    const rendererB = { render() { bCalls++; }, resize() {} };
    engine.addRenderer(rendererA);
    engine.addRenderer(rendererB);
    engine.isActive = true;

    assert.doesNotThrow(() => engine._tick(1000));
    assert.equal(engine.isActive, false);
    assert.equal(bCalls, 0); // truncated before rendererB's turn -- not rendered post-destroy
    assert.equal(engine.input, null);
    assert.equal(engine.spring, null);
});

test('destroy leaves zero live ResizeObservers and drops element refs', () => {
    const ROCtor = makeROFactory();
    const { engine } = makeEngine();
    const el = fakeEl({ offsetTop: 0, offsetHeight: 100 });
    const ds = new DOMScroller([el], fakePool, {
        binder: noopBinder(), win: fakeWin(0, 800), observe: true, ResizeObserverCtor: ROCtor
    });
    engine.addRenderer(ds);
    assert.equal(ROCtor.liveTotal(), 1);

    engine.destroy();
    assert.equal(ROCtor.liveTotal(), 0); // observer disconnected via the cascade
    assert.equal(ds.cache, null);        // element refs dropped
});
