/**
 * MetricsCache.js
 *
 * Pre-measures absolute document Y-bounds for every tracked element so the
 * render loop never touches getBoundingClientRect. The hot path only reads
 * the flat `bounds` Float32Array; measurement happens once on load and again
 * on resize.
 *
 * Two invalidation sources:
 *   - Explicit: call measure() (e.g. from the engine's window-resize handler).
 *   - Automatic (opt-in): pass { observe: true } to attach a ResizeObserver
 *     that re-measures when any observed element changes size -- image loads,
 *     font swaps, DOM mutations -- not just window resizes. When an element
 *     resizes, everything below it shifts, so all bounds are recomputed.
 *
 * The window and the ResizeObserver constructor are injectable, so the cache
 * measures headlessly against fakes under node:test.
 *
 * MIT License (c) Zahary Shinikchiev
 */

import { writeIntersectionBounds } from './MathMap.js';

export class MetricsCache {
    /**
     * @param {Array<{ getBoundingClientRect: Function }>} elements
     * @param {Window} [win] - defaults to the global window
     * @param {object} [options]
     * @param {boolean} [options.observe=false] - attach a ResizeObserver
     * @param {Function} [options.ResizeObserverCtor] - RO constructor (DI)
     * @param {Function} [options.onResize] - called after an auto re-measure
     */
    constructor(elements, win, options = {}) {
        this.elements = elements;
        this.count = elements.length;
        this.win = win || (typeof window !== 'undefined' ? window : null);

        // Stride of 2 per element: [enterY, exitY, enterY, exitY, ...]
        this.bounds = new Float32Array(this.count * 2);

        this._onResize = options.onResize || null;
        this._ro = null;

        const ROCtor = options.ResizeObserverCtor
            || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);

        if (options.observe && ROCtor) {
            // One observer, one coalesced callback per batch of entries -- we
            // re-measure the whole set once regardless of how many resized.
            this._ro = new ROCtor(() => {
                this.measure();
                if (this._onResize) this._onResize();
            });
            for (let i = 0; i < this.count; i++) {
                if (this.elements[i]) this._ro.observe(this.elements[i]);
            }
        }
    }

    /**
     * Recomputes all bounds. Read-only with respect to layout (a single batched
     * reflow), so it does not thrash. Call on load and on resize.
     */
    measure() {
        const win = this.win;
        if (!win) return;

        const scrollY = win.scrollY || win.pageYOffset || 0;
        const viewportHeight = win.innerHeight;
        const elements = this.elements;
        const bounds = this.bounds;

        for (let i = 0; i < this.count; i++) {
            const el = elements[i];
            if (!el) continue;

            const rect = el.getBoundingClientRect();
            const absoluteTop = rect.top + scrollY;

            writeIntersectionBounds(bounds, i * 2, absoluteTop, rect.height, viewportHeight);
        }
    }

    destroy() {
        if (this._ro) {
            this._ro.disconnect();
            this._ro = null;
        }
        this.elements = null;
        this.bounds = null;
        this.win = null;
        this._onResize = null;
    }
}
