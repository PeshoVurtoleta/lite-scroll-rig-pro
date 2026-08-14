/**
 * keyboard.test.js
 *
 * SR1 keyboard scrolling: arrows / page keys / space / home / end, on by
 * default, suppressed when focus is in an interactive control, off-switchable
 * via { keyboard: false }. Cold path only -- never touches _tick/render.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScrollEngine } from '../src/core/ScrollEngine.js';
import { fakeInput, fakeSpring, fakeTarget } from './fixtures.js';

function makeEngine(opts = {}) {
    const win = opts.win || fakeTarget({ scrollY: 0, innerHeight: 800 });
    const input = opts.input || fakeInput(opts.targetY || 0, opts.maxScroll != null ? opts.maxScroll : 1e9);
    const spring = opts.spring || fakeSpring();
    const engine = new ScrollEngine(null, {
        input, spring, win, raf: () => 1, cancelRaf: () => {},
        keyboard: opts.keyboard
    });
    return { engine, input, win };
}

test('ArrowDown steps +40, ArrowUp steps -40', () => {
    const { input, win } = makeEngine({ targetY: 100 });
    win.emitKey('ArrowDown');
    assert.equal(input.targetY, 140);
    win.emitKey('ArrowUp');
    assert.equal(input.targetY, 100);
});

test('PageDown / Space step +0.9*innerHeight (720 @ 800)', () => {
    const { input, win } = makeEngine();
    win.emitKey('PageDown');
    assert.equal(input.targetY, 720);
    win.emitKey('Home');
    win.emitKey(' ');
    assert.equal(input.targetY, 720, 'Space is a page-down');
});

test('Shift+Space steps up -0.9*innerHeight', () => {
    const { input, win } = makeEngine({ targetY: 1000 });
    win.emitKey(' ', { shiftKey: true });
    assert.equal(input.targetY, 280); // 1000 - 720
});

test('PageUp steps up -0.9*innerHeight', () => {
    const { input, win } = makeEngine({ targetY: 1000 });
    win.emitKey('PageUp');
    assert.equal(input.targetY, 280);
});

test('Home jumps to 0, End jumps to maxScroll', () => {
    const { input, win } = makeEngine({ targetY: 500, maxScroll: 4200 });
    win.emitKey('Home');
    assert.equal(input.targetY, 0);
    win.emitKey('End');
    assert.equal(input.targetY, 4200);
});

test('steps are clamped to [0, maxScroll]', () => {
    const { input, win } = makeEngine({ targetY: 0, maxScroll: 100 });
    win.emitKey('ArrowUp');
    assert.equal(input.targetY, 0, 'clamped at the floor');
    win.emitKey('PageDown');
    assert.equal(input.targetY, 100, 'clamped at the ceiling');
});

test('unhandled keys leave targetY unchanged', () => {
    const { input, win } = makeEngine({ targetY: 300 });
    win.emitKey('a');
    win.emitKey('Enter');
    win.emitKey('Tab');
    assert.equal(input.targetY, 300);
});

for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
    test('focus in <' + tag + '> suppresses the rig (targetY unchanged)', () => {
        const { input, win } = makeEngine({ targetY: 200 });
        win.emitKey('ArrowDown', { target: { tagName: tag } });
        assert.equal(input.targetY, 200, tag + ' consumes its own keys');
    });
}

test('contenteditable focus suppresses the rig', () => {
    const { input, win } = makeEngine({ targetY: 200 });
    win.emitKey('ArrowDown', { target: { tagName: 'DIV', isContentEditable: true } });
    assert.equal(input.targetY, 200);
});

test('fail closed: a null/absent event target suppresses the rig (never hijack an unverified event)', () => {
    const { input, win } = makeEngine({ targetY: 200 });
    win.emitKey('ArrowDown', { target: null });
    assert.equal(input.targetY, 200, 'a null target is unverified -> suppress, do not scroll');
    win.emitKey('ArrowDown', { target: undefined });
    assert.equal(input.targetY, 200, 'an absent target is unverified -> suppress');
});

test('control: with suppression NOT triggered the same key moves targetY', () => {
    const { input, win } = makeEngine({ targetY: 200 });
    // A non-interactive target (a plain DIV) is not suppressed.
    win.emitKey('ArrowDown', { target: { tagName: 'DIV' } });
    assert.equal(input.targetY, 240, 'proves the suppression above is what held it');
});

test('keyboard: false attaches no keydown listener (scroll stays on)', () => {
    const { win, input } = makeEngine({ keyboard: false });
    assert.equal(win.listenerCount('keydown'), 0, 'no keydown listener');
    assert.equal(win.listenerCount('scroll'), 1, 'native reconciliation still bound');
    win.emitKey('ArrowDown');
    assert.equal(input.targetY, 0, 'keys are inert when keyboard is off');
});

test('keyboard defaults on: keydown listener is bound', () => {
    const { win } = makeEngine();
    assert.equal(win.listenerCount('keydown'), 1);
});

test('destroy detaches the keydown listener', () => {
    const { engine, win, input } = makeEngine({ targetY: 100 });
    assert.equal(win.listenerCount('keydown'), 1);
    engine.destroy();
    assert.equal(win.listenerCount('keydown'), 0, 'keydown detached');
    assert.equal(win.listenerCount(), 0, 'no window listeners survive destroy');
    win.emitKey('ArrowDown');
    assert.equal(input.targetY, 100, 'inert after destroy');
});

test('preventDefault is skipped when the rig does not own the target (element-scoped)', () => {
    // _target is null in DI construction -> the rig owns nothing -> never
    // preventDefault, honoring "suppress only, never preventDefault outside the
    // rig target". Still steps targetY.
    const { input, win } = makeEngine({ targetY: 0 });
    const e = win.emitKey('ArrowDown', { target: { tagName: 'DIV' } });
    assert.equal(input.targetY, 40, 'still steps');
    assert.equal(e._prevented, false, 'no preventDefault outside an owned target');
});

// --- QA boundary pass: empty page, non-finite innerHeight, duplicate dispose,
//     and a re-entrant-write torture case. ---

test('boundary: End with maxScroll 0 (empty/short page) resolves to 0, never NaN', () => {
    const { input, win } = makeEngine({ targetY: 0, maxScroll: 0 });
    win.emitKey('End');
    assert.equal(input.targetY, 0, 'nothing to scroll -> 0, not NaN');
    assert.ok(input.targetY === input.targetY, 'never NaN');
});

test('boundary: Home with maxScroll 0 also resolves to 0', () => {
    const { input, win } = makeEngine({ targetY: 0, maxScroll: 0 });
    win.emitKey('Home');
    assert.equal(input.targetY, 0);
});

for (const [label, innerHeight] of [['0', 0], ['NaN', NaN], ['undefined', undefined]]) {
    test('boundary: PageDown with innerHeight=' + label + ' fails closed (no NaN target, no page move)', () => {
        const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
        win.innerHeight = innerHeight;
        const input = fakeInput(500, 1e9);
        const engine = new ScrollEngine(null, { input, spring: fakeSpring(), win, raf: () => 1, cancelRaf: () => {} });

        win.emitKey('PageDown');
        assert.ok(input.targetY === input.targetY, 'never NaN for innerHeight=' + label);
        assert.equal(input.targetY, 500, 'a non-finite/zero innerHeight yields no page step');
    });
}

test('boundary: PageDown with innerHeight=+Infinity does not scroll to Infinity (clamped by maxScroll)', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: Infinity });
    const input = fakeInput(500, 5000);
    const engine = new ScrollEngine(null, { input, spring: fakeSpring(), win, raf: () => 1, cancelRaf: () => {} });

    win.emitKey('PageDown');
    assert.equal(input.targetY, 5000, 'clamped to maxScroll, never Infinity');
    assert.ok(Number.isFinite(input.targetY));
});

test('boundary: PageUp with innerHeight=-Infinity fails closed to the floor (0), never NaN', () => {
    // -Infinity is truthy, so it survives `win.innerHeight || 0` (unlike 0/NaN/
    // undefined above) and produces a -Infinity page step; the clamp in
    // setTargetY must still floor it to 0, not NaN or a runaway negative.
    const win = fakeTarget({ scrollY: 0, innerHeight: -Infinity });
    const input = fakeInput(500, 1e9);
    const engine = new ScrollEngine(null, { input, spring: fakeSpring(), win, raf: () => 1, cancelRaf: () => {} });

    win.emitKey('PageDown');
    assert.ok(input.targetY === input.targetY, 'never NaN for innerHeight=-Infinity');
    assert.equal(input.targetY, 0, 'a -Infinity page step clamps to the floor');
});

test('duplicate dispose: destroying the engine twice leaves keydown listener count at 0 and does not throw', () => {
    const { engine, win, input } = makeEngine({ targetY: 100 });
    engine.destroy();
    assert.equal(win.listenerCount('keydown'), 0);

    assert.doesNotThrow(() => engine.destroy(), 'a second destroy() must not throw');
    assert.equal(win.listenerCount('keydown'), 0, 'still 0 after the duplicate dispose');

    win.emitKey('ArrowDown');
    assert.equal(input.targetY, 100, 'inert after the duplicate dispose');
});

// Adversarial / re-entrant-write case (decisions/0003 RISK: double-counting a
// key press that ALSO provokes a native browser scroll). Simulates a keydown
// handler whose setTargetY call synchronously provokes a native 'scroll' event
// (as if preventDefault were not honored, or a nested control also scrolled),
// re-entering the reconciler WHILE the keydown dispatch is still on the stack.
test('adversarial: a keydown step that re-entrantly triggers a native scroll mid-dispatch does not double-count or corrupt state', () => {
    const win = fakeTarget({ scrollY: 0, innerHeight: 800 });
    let reentered = false;
    const input = {
        targetY: 100,
        maxScroll: 1e9,
        _lastNativeY: 100,
        setTargetY(y) {
            if (y !== y) return;
            let v = y;
            if (v < 0) v = 0; else if (v > this.maxScroll) v = this.maxScroll;
            this.targetY = v;
            // First write only: simulate the browser ALSO scrolling natively to
            // the same spot before our preventDefault takes effect, re-entering
            // the reconciler synchronously.
            if (!reentered && v === 140) {
                reentered = true;
                win.emitScroll(140);
            }
        }
    };
    const engine = new ScrollEngine(null, { input, spring: fakeSpring(), win, raf: () => 1, cancelRaf: () => {} });

    assert.doesNotThrow(() => win.emitKey('ArrowDown'));
    // The keydown step (100 -> 140) and the re-entrant native reconciliation to
    // the same 140 agree -- no double count, no corruption, no throw.
    assert.equal(input.targetY, 140);
    assert.equal(input._lastNativeY, 140, 'reconciler baseline advanced from the re-entrant scroll');
});
