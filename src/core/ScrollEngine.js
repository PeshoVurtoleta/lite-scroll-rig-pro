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
     */
    constructor(target, options = {}) {
        const win = options.win || (typeof window !== 'undefined' ? window : null);
        this.win = win;

        this.input = options.input || new VirtualScroll(target, {
            multiplier: options.multiplier,
            touchMultiplier: options.touchMultiplier,
            createTracker: options.createTracker,
            doc: options.doc
        });

        const preset = springPreset[options.preset] || springPreset.gentle;
        this.spring = options.spring || new Spring(preset[0], preset[1], 0);

        this._subscribers = [];
        this.currentY = 0;
        this.isActive = false;
        this._lastTime = 0;
        this._maxDeltaTime = options.maxDeltaTime != null ? options.maxDeltaTime : DEFAULT_MAX_DT;
        this._getMaxScroll = options.getMaxScroll || null;

        const matchMedia = options.matchMedia
            || (win && typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null);
        this._reducedMotion = (typeof options.reducedMotion === 'boolean')
            ? options.reducedMotion
            : (matchMedia ? !!matchMedia('(prefers-reduced-motion: reduce)').matches : false);

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
    }

    /**
     * Register a renderer: an object with `render(currentY)` and optionally
     * `resize()`. resize() is called once on registration to seed layout.
     */
    addRenderer(renderer) {
        this._subscribers.push(renderer);
        if (typeof renderer.resize === 'function') renderer.resize();
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
    }

    /** Snap to the current scroll position and start the frame loop. */
    start() {
        if (this.isActive) return;

        const startY = this.win ? (this.win.scrollY || 0) : 0;
        this.currentY = startY;
        this.input.targetY = startY;
        if (typeof this.spring.snap === 'function') this.spring.snap(startY);

        this.isActive = true;
        this._lastTime = 0;
        if (this._raf) this._rafHandle = this._raf(this._boundTick);
    }

    _tick(time) {
        if (!this.isActive) return;

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

        if (this._raf) this._rafHandle = this._raf(this._boundTick);
    }

    destroy() {
        this.isActive = false;
        if (this._cancelRaf && this._rafHandle) this._cancelRaf(this._rafHandle);
        this._rafHandle = 0;
        this._subscribers.length = 0;
        if (this.input && typeof this.input.destroy === 'function') this.input.destroy();
        this.input = null;
    }
}
