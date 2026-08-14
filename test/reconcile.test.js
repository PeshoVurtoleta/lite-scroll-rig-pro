/**
 * reconcile.test.js
 *
 * SR1 native scroll reconciliation: native wins. The rig is transform-only, so
 * every native scroll is foreign -- the engine reconciles targetY to
 * window.scrollY and snaps the spring past the 200 px page-jump threshold.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScrollEngine } from '../src/core/ScrollEngine.js';
import { fakeInput, fakeSpring, fakeTarget } from './fixtures.js';

function makeEngine(win, opts = {}) {
    const input = opts.input || fakeInput(0, opts.maxScroll != null ? opts.maxScroll : 1e9);
    const spring = opts.spring || fakeSpring();
    const engine = new ScrollEngine(null, {
        input, spring, win, raf: () => 1, cancelRaf: () => {}
    });
    return { engine, input, spring };
}

test('a large foreign scroll (0->4200) reconciles in one dispatch and snaps the spring', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { input, spring } = makeEngine(win);

    win.emitScroll(4200);

    assert.equal(input.targetY, 4200, 'targetY reconciled to native scrollY (native wins)');
    assert.equal(spring.snapped, 4200, 'a >=200 px jump snaps the spring to the target');
    assert.equal(input._lastNativeY, 4200, 'reconciler baseline advanced');
});

test('a small foreign delta (40 px) reconciles but does not snap the spring', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { input, spring } = makeEngine(win);

    win.emitScroll(40);

    assert.equal(input.targetY, 40, 'targetY tracks native scrollY below the threshold');
    assert.equal(spring.snapped, null, 'below 200 px the spring chases, never snaps');
});

test('exactly 200 px snaps (threshold is inclusive)', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { spring } = makeEngine(win);

    win.emitScroll(200);
    assert.equal(spring.snapped, 200, '200 px is at the snap threshold');
});

test('a negative foreign jump (up) snaps too', () => {
    const win = fakeTarget({ scrollY: 1000, innerHeight: 800 });
    const { input, spring } = makeEngine(win, { input: fakeInput(1000, 1e9) });
    input._lastNativeY = 1000;

    win.emitScroll(300); // delta -700
    assert.equal(input.targetY, 300);
    assert.equal(spring.snapped, 300, 'a large upward jump snaps as well');
});

test('a redundant re-dispatch of the same position is a no-op (self-vs-foreign seam)', () => {
    const win = fakeTarget({ scrollY: 500, innerHeight: 800 });
    const { input, spring } = makeEngine(win);
    input._lastNativeY = 500;

    win.emitScroll(500);
    assert.equal(spring.snapped, null, 'no snap for a zero foreign delta');
    assert.equal(input.targetY, 0, 'setTargetY never called for a self/no-op scroll');
});

test('the reconciled target is clamped to maxScroll', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { input, spring } = makeEngine(win, { maxScroll: 3000 });

    win.emitScroll(9999);
    assert.equal(input.targetY, 3000, 'clamped to the ceiling');
    assert.equal(spring.snapped, 3000, 'snap uses the clamped value');
});

test('control: an engine not listening on the target leaves targetY at 0', () => {
    const orphan = fakeTarget({ scrollY: 0, innerHeight: 800 });
    // win: null -> the engine attaches no listeners.
    const { input } = makeEngine(null);

    orphan.emitScroll(4200);

    assert.equal(input.targetY, 0, 'no listener means no reconciliation');
    assert.equal(orphan.listenerCount('scroll'), 0, 'the orphan target was never bound');
});

test('destroy detaches the scroll listener', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { engine, input } = makeEngine(win);
    assert.equal(win.listenerCount('scroll'), 1, 'bound on construction');

    engine.destroy();
    assert.equal(win.listenerCount('scroll'), 0, 'detached on destroy');

    // A late scroll after destroy must not throw or mutate.
    win.emitScroll(4200);
    assert.equal(input.targetY, 0);
});

test('start() seeds the reconciler baseline so the first delta is measured from there', () => {
    const win = fakeTarget({ scrollY: 150, innerHeight: 800 });
    const { engine, input, spring } = makeEngine(win);
    engine.start();
    assert.equal(input._lastNativeY, 150, 'baseline seeded to the start position');

    win.emitScroll(190); // delta 40 from 150 -> no snap
    assert.equal(input.targetY, 190);
    assert.equal(spring.snapped, 150, 'only start() snapped (150); the 40 px delta did not');
});

// --- QA boundary pass: threshold N-1/N+1, negative small delta, duplicate
//     dispose, and a re-entrant-write torture case per decisions/0003 RISK. ---

test('boundary: 199 px (just below threshold) reconciles but does NOT snap', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { input, spring } = makeEngine(win);

    win.emitScroll(199);
    assert.equal(input.targetY, 199, 'targetY tracks the foreign delta');
    assert.equal(spring.snapped, null, '199 px is one below the inclusive 200 px threshold');
});

test('boundary: 201 px (just above threshold) snaps', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { spring } = makeEngine(win);

    win.emitScroll(201);
    assert.equal(spring.snapped, 201, '201 px is one above the inclusive 200 px threshold');
});

test('boundary: a small negative foreign delta (-40) reconciles but does not snap', () => {
    const win = fakeTarget({ scrollY: 1000, innerHeight: 800 });
    const { input, spring } = makeEngine(win, { input: fakeInput(1000, 1e9) });
    input._lastNativeY = 1000;

    win.emitScroll(960); // delta -40
    assert.equal(input.targetY, 960);
    assert.equal(spring.snapped, null, 'a small upward delta chases, never snaps');
});

test('boundary: -199 vs -200 vs -201 foreign deltas straddle the snap threshold symmetrically', () => {
    const mk = (start) => {
        const win = fakeTarget({ scrollY: start, innerHeight: 800 });
        const input = fakeInput(start, 1e9);
        input._lastNativeY = start;
        const { spring } = makeEngine(win, { input });
        return { win, spring };
    };

    const a = mk(1000);
    a.win.emitScroll(801); // delta -199
    assert.equal(a.spring.snapped, null, '-199 does not snap');

    const b = mk(1000);
    b.win.emitScroll(800); // delta -200
    assert.equal(b.spring.snapped, 800, '-200 snaps (inclusive)');

    const c = mk(1000);
    c.win.emitScroll(799); // delta -201
    assert.equal(c.spring.snapped, 799, '-201 snaps');
});

test('a foreign scroll of NaN/undefined (fail closed) reconciles to 0, never propagates NaN', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { input } = makeEngine(win);

    // A hostile/broken environment reporting a non-finite scrollY must not hand
    // the spring a NaN target.
    win.scrollY = NaN;
    win.emitScroll();
    assert.equal(input.targetY, 0, 'NaN scrollY coerces to 0, not NaN');
    assert.ok(input.targetY === input.targetY, 'never NaN');
});

test('duplicate dispose: destroying the engine twice leaves scroll+keydown listener counts at 0 and does not throw', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const { engine, input } = makeEngine(win);
    assert.equal(win.listenerCount(), 2, 'scroll + keydown bound on construction');

    engine.destroy();
    assert.equal(win.listenerCount(), 0, 'both detached on first destroy');

    assert.doesNotThrow(() => engine.destroy(), 'a second destroy() must not throw');
    assert.equal(win.listenerCount(), 0, 'still 0 after the duplicate dispose');

    // A late scroll after the duplicate dispose must remain inert.
    win.emitScroll(4200);
    assert.equal(input.targetY, 0);
});

// Adversarial / re-entrant-write case (decisions/0003 RISK: double-counting).
// Simulates a hostile spring.snap() that itself re-enters _onNativeScroll
// synchronously (e.g. a badly-behaved consumer plugin), as if a second foreign
// scroll landed mid-reconciliation. The reconciler must not corrupt state or
// recurse unboundedly -- the innermost (most recent) write must win and the
// outer call must complete cleanly afterward.
test('adversarial: a re-entrant write from inside spring.snap() during reconciliation does not corrupt state or recurse unboundedly', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    const input = fakeInput(0, 1e9);
    let depth = 0;
    const spring = {
        target: 0, snapped: null,
        snap(v) {
            this.snapped = v;
            this.target = v;
            if (depth === 0) {
                depth = 1;
                // Re-enter: a second, larger foreign scroll arrives WHILE the
                // first is still being reconciled.
                win.emitScroll(9000);
            }
        },
        update() { return this.target; }
    };
    const engine = new ScrollEngine(null, { input, spring, win, raf: () => 1, cancelRaf: () => {} });

    assert.doesNotThrow(() => win.emitScroll(4200));
    // The re-entrant call (9000) landed last and its snap ran last -> it wins.
    assert.equal(input.targetY, 9000, 'the innermost, most recent reconciliation wins');
    assert.equal(spring.snapped, 9000);
    assert.equal(input._lastNativeY, 9000, 'reconciler baseline reflects the final write');
});
