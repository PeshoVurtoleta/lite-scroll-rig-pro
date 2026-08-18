/**
 * ScrollEngine.js
 *
 * The orchestrator. Owns the input layer (VirtualScroll), a spring, and a list
 * of renderers, and runs the animation frame loop.
 *
 * INTERPOLATION -- the bit that turns stepped input into smooth motion:
 * VirtualScroll produces a raw, instantly-clamped `targetY` (mouse wheels emit
 * discrete steps, so this value is jumpy). ScrollEngine does NOT hand that to
 * renderers directly. Instead a spring chases it:
 *
 *     spring.target = input.targetY;         // the jumpy goal
 *     currentY = spring.update(dt);          // the smoothed, eased value
 *
 * `currentY` is what every renderer receives and what feeds computeProgress().
 * Swapping the spring preset changes the entire feel (see the `preset` option
 * or inject your own spring). With prefers-reduced-motion the spring is
 * bypassed and currentY snaps to targetY, so the page tracks input 1:1.
 *
 * dt is clamped so a backgrounded tab that resumes after seconds does not feed
 * the spring a huge timestep and lurch. Everything external (spring, input,
 * window, rAF, reduced-motion query) is injectable for headless testing.
 *
 * MIT License (c) Zahary Shinikchiev
 */

import { Spring, springPreset } from '@zakkster/lite-spring';
import { VirtualScroll } from './VirtualScroll.js';

const DEFAULT_MAX_DT = 0.05; // seconds; ~20fps floor on the spring step

// Native reconciliation + keyboard (cold path only; see decisions/0003).
const NATIVE_SNAP_PX = 200;     // foreign scroll jump at/above which the spring snaps
const KEY_LINE_STEP = 40;       // ArrowUp/ArrowDown step (px), matches wheel LINE_STEP
const KEY_PAGE_FRACTION = 0.9;  // PageUp/PageDown/Space step = 0.9 * innerHeight

// Idle discipline: park the rAF loop when settled, wake on input. See
// decisions/0004-park-wake.md. A frame counts as settled when the on-screen
// value is within SETTLE_EPS_PX of the target AND the spring velocity is under
// SETTLE_VEL (a non-finite velocity fails the comparison, so it is NEVER
// settled -- fail closed). After SETTLE_N consecutive settled frames the loop
// parks. Tight enough that a sub-pixel drift never reads as motion; loose
// enough that a genuinely resting spring parks within a few frames.
const SETTLE_EPS_PX = 0.05;
const SETTLE_VEL = 0.5;
const SETTLE_N = 3;

export class ScrollEngine {
    /**
     * @param {HTMLElement|Window} target - input target (usually window)
     * @param {object} [options]
     * @param {string}   [options.preset='gentle'] - lite-spring preset name
     * @param {number}   [options.maxDeltaTime=0.05] - dt clamp (seconds)
     * @param {Function} [options.getMaxScroll] - () => number; overrides the
     *                   default documentElement.scrollHeight - innerHeight
     * @param {boolean}  [options.reducedMotion] - force on/off (else derived
     *                   from prefers-reduced-motion via matchMedia)
     * @param {object}   [options.input] - VirtualScroll-like instance (DI)
     * @param {object}   [options.spring] - Spring-like instance (DI)
     * @param {Window}   [options.win] - window (DI)
     * @param {Function} [options.raf] - requestAnimationFrame-like (DI)
     * @param {Function} [options.cancelRaf] - cancelAnimationFrame-like (DI)
     * @param {Function} [options.matchMedia] - matchMedia-like (DI)
     * @param {number}   [options.multiplier] - forwarded to VirtualScroll
     * @param {number}   [options.touchMultiplier] - forwarded to VirtualScroll
     * @param {Function} [options.createTracker] - forwarded to VirtualScroll
     * @param {Document} [options.doc] - forwarded to VirtualScroll
     * @param {boolean}  [options.keyboard=true] - bind window keydown scrolling
     *                   (arrows / page / space / home / end); interactive-element
     *                   focus is always suppressed. false detaches only keydown.
     * @param {boolean}  [options.park=true] - park the rAF loop when the spring
     *                   settles and wake it on input (wheel/touch/keyboard/native
     *                   scroll/resize/RO). false keeps the loop running every
     *                   frame. See decisions/0004-park-wake.md.
     */
    constructor(target, options = {}) {
        const win = options.win || (typeof window !== 'undefined' ? window : null);
        this.win = win;
        this._target = target;

        this.input = options.input || new VirtualScroll(target, {
            multiplier: options.multiplier,
            touchMultiplier: options.touchMultiplier,
            createTracker: options.createTracker,
            doc: options.doc
        });

        // Fail closed on an actual typo: a preset key that was PROVIDED but does
        // not exist is a misconfiguration, not a request for the default -- a
        // silent gentle fallback would hide it forever. Absent/undefined preset
        // still defaults to gentle without throwing.
        let preset;
        if (options.preset == null) {
            preset = springPreset.gentle;
        } else if (Object.prototype.hasOwnProperty.call(springPreset, options.preset)) {
            // Own-property check only: springPreset[options.preset] would walk the
            // prototype chain, so 'constructor'/'__proto__'/'toString'/... resolve
            // to truthy inherited members, slip the guard, and yield a NaN spring.
            preset = springPreset[options.preset];
        } else {
            throw new RangeError(
                'ScrollEngine: unknown spring preset "' + options.preset +
                '". Valid presets: ' + Object.keys(springPreset).join(', ') + '.'
            );
        }
        this.spring = options.spring || new Spring(preset[0], preset[1], 0);

        this._subscribers = [];
        this.currentY = 0;
        this.isActive = false;
        this._lastTime = 0;
        this._maxDeltaTime = options.maxDeltaTime != null ? options.maxDeltaTime : DEFAULT_MAX_DT;
        this._getMaxScroll = options.getMaxScroll || null;

        // Idle discipline (SR-05). Preallocated so _tick only ever reads/writes
        // existing fields -- no shape change on the hot path. isParked is public
        // for a HUD. _settle counts consecutive settled frames; _wakePending
        // guards the re-entrant race where wake() is called from inside a
        // renderer's render() during this same tick (the event-before-rAF case is
        // already covered by wake() zeroing _settle). park is on by default;
        // { park: false } keeps the loop always running.
        this.isParked = false;
        this._settle = 0;
        this._wakePending = false;
        this._lastTargetY = 0;
        this._parkEnabled = options.park !== false;

        const matchMedia = options.matchMedia
            || (win && typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null);

        // Keep the MQL object live so prefers-reduced-motion changes are honored
        // mid-session, not just at construction. A forced boolean has no live
        // query, so no listener is attached.
        this._mql = null;
        this._onMotionChange = null;

        if (typeof options.reducedMotion === 'boolean') {
            this._reducedMotion = options.reducedMotion;
        } else if (matchMedia) {
            const mql = matchMedia('(prefers-reduced-motion: reduce)');
            this._mql = mql;
            this._reducedMotion = !!(mql && mql.matches);

            // Snap the spring on every transition so it never resumes from a
            // stale value. Entering reduced motion: snap to the target so a
            // mid-flight spring stops easing the instant the user asks. Leaving
            // it: snap to the live on-screen position (currentY) so smoothing
            // resumes from where the page actually is, not from a value frozen
            // at the enable moment -- otherwise the next _tick jumps backward.
            this._onMotionChange = (e) => {
                const enabled = !!(e && e.matches);
                this._reducedMotion = enabled;
                if (enabled) {
                    this.spring?.snap?.(this.input ? this.input.targetY : 0);
                } else {
                    this.spring?.snap?.(this.currentY);
                }
            };
            if (mql && typeof mql.addEventListener === 'function') {
                mql.addEventListener('change', this._onMotionChange);
            }
        } else {
            this._reducedMotion = false;
        }

        // Native rAF/cAF must be invoked with `this` === the global object. Called
        // off a class property they lose that receiver and throw "Illegal invocation"
        // in browsers, so the native fallbacks are bound to the window. Injected
        // timers (tests) are already context-free and used as-is.
        this._raf = options.raf
            || (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame.bind(win || globalThis) : null);
        this._cancelRaf = options.cancelRaf
            || (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame.bind(win || globalThis) : null);
        this._rafHandle = 0;
        this._boundTick = this._tick.bind(this);

        // Wake hook. VirtualScroll calls input._onInput() after any targetY
        // change (wheel/touch/setTargetY), so wheel and touch wake a parked
        // engine without the engine listening for those events itself. Native
        // scroll, keyboard, resize, addRenderer, and RO invalidation call wake()
        // directly. All cold path -- wake() only schedules a frame when parked.
        this._boundWake = this.wake.bind(this);
        if (this.input) this.input._onInput = this._boundWake;

        // Native reconciliation + keyboard live entirely on the cold path: bound
        // window listeners that write primitives into input.targetY. The rig is
        // transform-only (no window.scrollTo), so a native scroll is always
        // FOREIGN -- the reconciler tracks it (native wins), snapping the spring
        // past a page-jump. keydown drives step/page/home/end, suppressed when
        // focus sits in an interactive control. Nothing here touches _tick or
        // render, so the hot bodies gain zero bytes. See decisions/0003.
        this._keyboard = options.keyboard !== false;
        this._boundNativeScroll = this._onNativeScroll.bind(this);
        this._boundKeyDown = this._onKeyDown.bind(this);
        this._listening = false;
        if (win && typeof win.addEventListener === 'function') {
            win.addEventListener('scroll', this._boundNativeScroll, { passive: true });
            if (this._keyboard) win.addEventListener('keydown', this._boundKeyDown);
            this._listening = true;
        }
    }

    /**
     * Foreign native scroll -> reconcile the input target to window.scrollY
     * (native wins). A jump of NATIVE_SNAP_PX or more also snaps the spring so a
     * scrollbar drag or an in-page anchor jump lands in one frame instead of
     * easing across the whole page. Cold path; allocates nothing.
     */
    _onNativeScroll() {
        const input = this.input;
        const win = this.win;
        if (!input || !win) return;
        const y = win.scrollY || 0;
        const last = input._lastNativeY;
        // Self-vs-foreign seam: a scroll the rig itself caused (a future deferred
        // nativeSync via window.scrollTo) would land at _lastNativeY. We never
        // scrollTo today, so this only skips a redundant re-dispatch of the same
        // position.
        if (y === last) return;
        const d = y - last;
        input._lastNativeY = y;
        input.setTargetY(y);
        if (d >= NATIVE_SNAP_PX || d <= -NATIVE_SNAP_PX) {
            const spring = this.spring;
            if (spring && typeof spring.snap === 'function') spring.snap(input.targetY);
        }
        this.wake();
    }

    /**
     * True when the event target is a control that consumes its own keys, so the
     * rig must not steal them (typing in a field, operating a select/button, or
     * editing contenteditable). Fail closed: a real keydown always carries a
     * target, so a null/absent one is an unverified state -- treat it as
     * interactive and suppress, never hijack the keyboard on an event we cannot
     * verify. null is not zero.
     */
    _isInteractive(el) {
        if (!el) return true;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
    }

    /**
     * Whether the rig owns this event's target, gating preventDefault. A
     * window-scoped rig owns the whole page; an element-scoped rig owns only its
     * own subtree. Never preventDefault outside the rig target: a nested scroller
     * the rig does not manage must keep its native keys. See decisions/0003 RISK.
     */
    _ownsEvent(e) {
        const t = this._target;
        if (!t) return false;
        if (this.win && t === this.win) return true;
        const et = e && e.target;
        if (et === t) return true;
        return typeof t.contains === 'function' ? !!t.contains(et) : false;
    }

    /**
     * Keyboard scrolling. Writes clamped primitives into the input target; never
     * reads or touches the hot loop. Suppressed entirely when focus is in an
     * interactive control. preventDefault only when the rig owns the target, so
     * the browser's own keyboard scroll cannot double-count on top of ours.
     */
    _onKeyDown(e) {
        const input = this.input;
        if (!input) return;
        if (this._isInteractive(e.target)) return;

        const win = this.win;
        const page = (win ? win.innerHeight || 0 : 0) * KEY_PAGE_FRACTION;
        let handled = true;
        switch (e.key) {
            case 'ArrowDown': input.setTargetY(input.targetY + KEY_LINE_STEP); break;
            case 'ArrowUp':   input.setTargetY(input.targetY - KEY_LINE_STEP); break;
            case 'PageDown':  input.setTargetY(input.targetY + page); break;
            case 'PageUp':    input.setTargetY(input.targetY - page); break;
            case ' ':         input.setTargetY(input.targetY + (e.shiftKey ? -page : page)); break;
            case 'Home':      input.setTargetY(0); break;
            case 'End':       input.setTargetY(input.maxScroll); break;
            default: handled = false;
        }
        if (handled) {
            this.wake();
            if (e.cancelable && this._ownsEvent(e) && typeof e.preventDefault === 'function') {
                e.preventDefault();
            }
        }
    }

    /**
     * Register a renderer: an object with `render(currentY)` and optionally
     * `resize()`. resize() is called once on registration to seed layout.
     */
    addRenderer(renderer) {
        this._subscribers.push(renderer);
        // Wake wiring: a renderer that invalidates asynchronously (e.g. a
        // DOMScroller whose ResizeObserver fires on a late image load) must be
        // able to wake a parked engine so the new bounds actually render. If the
        // renderer exposes the _onInvalidate seam, route it to wake. Cold path.
        if (renderer && Object.prototype.hasOwnProperty.call(renderer, '_onInvalidate')) {
            renderer._onInvalidate = this._boundWake;
        }
        if (typeof renderer.resize === 'function') {
            renderer.resize();
            this.wake(); // registration reseeds layout -> a frame must run
        }
        return this;
    }

    _defaultMaxScroll() {
        if (!this.win) return 0;
        const doc = this.win.document;
        const scrollHeight = (doc && doc.documentElement) ? doc.documentElement.scrollHeight : 0;
        const max = scrollHeight - this.win.innerHeight;
        return max > 0 ? max : 0;
    }

    /** Recompute the scroll ceiling and notify renderers. Call on resize. */
    resize() {
        const maxScroll = this._getMaxScroll ? this._getMaxScroll() : this._defaultMaxScroll();
        this.input.setMaxScroll(maxScroll);

        const subs = this._subscribers;
        for (let i = 0; i < subs.length; i++) {
            if (typeof subs[i].resize === 'function') subs[i].resize();
        }
        this.wake(); // new geometry must be rendered even if the loop had parked
    }

    /** Snap to the current scroll position and start the frame loop. */
    start() {
        if (this.isActive) return;

        const startY = this.win ? (this.win.scrollY || 0) : 0;
        this.currentY = startY;
        this.input.targetY = startY;
        // Seed the reconciler baseline so the first native scroll after start()
        // measures its foreign delta from where we actually began, not from 0.
        this.input._lastNativeY = startY;
        if (typeof this.spring.snap === 'function') this.spring.snap(startY);

        this.isActive = true;
        this.isParked = false;
        this._settle = 0;
        this._wakePending = false;
        this._lastTargetY = startY;
        this._lastTime = 0;
        if (this._raf) this._rafHandle = this._raf(this._boundTick);
    }

    _tick(time) {
        if (!this.isActive) return;
        this._wakePending = false; // wake() during this tick will re-set it

        // dt in seconds, clamped so a resumed background tab does not lurch.
        let dt = this._lastTime ? (time - this._lastTime) / 1000 : 0;
        this._lastTime = time;
        if (dt > this._maxDeltaTime) dt = this._maxDeltaTime;
        else if (dt < 0) dt = 0;

        const targetY = this.input.targetY;

        if (this._reducedMotion) {
            this.currentY = targetY;          // 1:1, no spring smoothing
        } else {
            this.spring.target = targetY;
            this.currentY = this.spring.update(dt);
        }

        const subs = this._subscribers;
        for (let i = 0; i < subs.length; i++) subs[i].render(this.currentY);

        // A renderer may synchronously destroy() the engine (an SPA unmount from
        // inside render()); destroy() nulls this.spring and tears down the raf +
        // listeners. Bail before touching the settle path -- do NOT reschedule,
        // the loop is already dead. Fail closed on the torn-down state.
        if (!this.spring) return;

        // Idle discipline. velocity is read into a local and gated on
        // Number.isFinite so EVERY non-finite/absent value fails closed: null
        // (Math.abs(null) coerces to 0 -- "null is not zero"), undefined, NaN,
        // and +/-Infinity are all rejected, so the loop only parks on a spring at
        // a verified rest. In reduced motion currentY tracks targetY 1:1, so rest
        // is a stationary target across two frames.
        const v = this.spring.velocity;
        const settled = Math.abs(this.currentY - targetY) < SETTLE_EPS_PX
            && (this._reducedMotion
                ? targetY === this._lastTargetY
                : (Number.isFinite(v) && Math.abs(v) < SETTLE_VEL));
        this._lastTargetY = targetY;

        if (settled && this._parkEnabled && ++this._settle >= SETTLE_N && !this._wakePending) {
            this._park();
        } else {
            if (!settled) this._settle = 0;
            if (this._raf) this._rafHandle = this._raf(this._boundTick);
        }
    }

    /**
     * Wake the frame loop (cold path). Resets the settle counter so an in-flight
     * park attempt is aborted, and marks _wakePending so a wake landing inside
     * the current tick blocks that tick from parking (the same-tick race). Only
     * schedules a frame when the loop is actually parked and the engine is live,
     * and only ever a SINGLE frame -- never a double schedule.
     */
    wake() {
        this._wakePending = true;
        this._settle = 0;
        if (this.isParked && this.isActive) {
            this.isParked = false;
            this._lastTime = 0; // fresh dt baseline so the resumed frame does not lurch
            if (this._raf) this._rafHandle = this._raf(this._boundTick);
        }
    }

    /**
     * Park the frame loop (cold path, from _tick only). Sets isParked and stops
     * rescheduling; the current tick simply does not queue another. wake()
     * restarts it. Does not reschedule.
     */
    _park() {
        this.isParked = true;
        this._rafHandle = 0;
    }

    destroy() {
        this.isActive = false;
        this.isParked = false;
        if (this._cancelRaf && this._rafHandle) this._cancelRaf(this._rafHandle);
        this._rafHandle = 0;

        // Ownership: the engine tears down every renderer addRenderer received,
        // symmetric with calling resize() on registration. Detach observers and
        // listeners BEFORE dropping refs -- order matters. See decisions/0002.
        const subs = this._subscribers;
        for (let i = 0; i < subs.length; i++) {
            const r = subs[i];
            if (r && typeof r.destroy === 'function') r.destroy();
        }
        subs.length = 0;

        // Detach the live reduced-motion listener before dropping its refs.
        if (this._mql && this._onMotionChange && typeof this._mql.removeEventListener === 'function') {
            this._mql.removeEventListener('change', this._onMotionChange);
        }
        this._mql = null;
        this._onMotionChange = null;

        // Detach both window listeners (native scroll + keydown) before nulling
        // the refs they close over. Order matters -- see decisions/0002, 0003.
        if (this._listening && this.win && typeof this.win.removeEventListener === 'function') {
            this.win.removeEventListener('scroll', this._boundNativeScroll);
            this.win.removeEventListener('keydown', this._boundKeyDown);
        }
        this._listening = false;

        if (this.input && typeof this.input.destroy === 'function') this.input.destroy();
        this.input = null;
        this.spring = null;
    }
}
