/**
 * VirtualScroll.js
 *
 * Normalizes wheel/trackpad/touch input into a single clamped Y target.
 * Desktop uses the wheel event (with deltaMode normalization). Touch/pen use a
 * pan gesture via @zakkster/lite-gesture, which reports a per-frame frameDy and
 * distinguishes pans from pinches -- so a two-finger zoom never drives scroll.
 *
 * The gesture factory is injectable, so the whole class runs headlessly under
 * node:test with a fake tracker.
 *
 * MIT License (c) Zahary Shinikchiev
 */

import { GestureTracker } from '@zakkster/lite-gesture';

// Standardize Firefox deltaMode units to raw pixels.
const LINE_STEP = 40;
const PAGE_STEP = 800;

export class VirtualScroll {
    /**
     * @param {HTMLElement|Window} target - wheel target (usually window)
     * @param {object} [options]
     * @param {number} [options.maxScroll=0] - scrollHeight - innerHeight
     * @param {number} [options.multiplier=1.2] - desktop wheel speed
     * @param {number} [options.touchMultiplier=1.5] - touch pan speed
     * @param {Function} [options.createTracker=GestureTracker] - gesture factory (DI)
     * @param {Document} [options.doc] - document (DI; resolves window -> root el)
     */
    constructor(target, options = {}) {
        const {
            maxScroll = 0,
            multiplier = 1.2,
            touchMultiplier = 1.5,
            createTracker = GestureTracker,
            doc = (typeof document !== 'undefined' ? document : null)
        } = options;

        this.target = target;
        this.maxScroll = maxScroll;
        this.multiplier = multiplier;
        this.touchMultiplier = touchMultiplier;

        this.targetY = 0;
        this.isActive = true;

        this._onWheel = this._onWheel.bind(this);
        target.addEventListener('wheel', this._onWheel, { passive: false });

        // Touch/pen panning. GestureTracker supplies a per-frame frameDy and
        // only fires onPanMove for pans, so pinch-zoom gestures never scroll.
        const trackerEl = (typeof window !== 'undefined' && target === window && doc)
            ? doc.documentElement
            : target;

        this._tracker = createTracker(trackerEl, {
            onPanMove: ({ frameDy }) => {
                if (!this.isActive) return;
                // Inverted: dragging the finger up scrolls content down.
                this._clampAndApply(-frameDy * this.touchMultiplier);
            }
        });
    }

    /** Update the scroll ceiling (call on resize). Re-clamps immediately. */
    setMaxScroll(max) {
        this.maxScroll = max;
        this._clampAndApply(0);
    }

    _onWheel(e) {
        if (!this.isActive) return;
        if (e.cancelable) e.preventDefault();

        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= LINE_STEP;
        else if (e.deltaMode === 2) delta *= PAGE_STEP;

        delta *= this.multiplier;
        this._clampAndApply(delta);
    }

    _clampAndApply(deltaY) {
        this.targetY += deltaY;
        if (this.targetY < 0) this.targetY = 0;
        if (this.targetY > this.maxScroll) this.targetY = this.maxScroll;
    }

    destroy() {
        this.isActive = false;
        this.target.removeEventListener('wheel', this._onWheel);
        if (this._tracker && typeof this._tracker.destroy === 'function') this._tracker.destroy();
        this._tracker = null;
    }
}
