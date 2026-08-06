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
     * @param {string}  [options.measure] - 'rect' forces the legacy
     *                  getBoundingClientRect source (test-only control that
     *                  reproduces the v1.0.0 transform pollution). Any other
     *                  value uses the default offsetTop-chain source.
     */
    constructor(elements, win, options = {}) {
        this.elements = elements;
        this.count = elements.length;
        this.win = win || (typeof window !== 'undefined' ? window : null);

        // Stride of 2 per element: [enterY, exitY, enterY, exitY, ...]
        this.bounds = new Float32Array(this.count * 2);

        this._onResize = options.onResize || null;
        this._measure = options.measure || null;
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
     * Accumulates an element's absolute document-Y top by walking the
     * offsetParent chain and summing offsetTop. This is LAYOUT space, so a live
     * transform on the element (scale/translate) never leaks into the number --
     * the fix for SR-01, see decisions/0001-measurement.md. When offsetParent is
     * null the loop naturally reduces to (el.offsetTop || 0). Allocation-free.
     */
    _absoluteTop(el) {
        let top = 0;
        let node = el;
        while (node) {
            const t = node.offsetTop;
            // Fail closed: a non-finite offsetTop anywhere in the chain is an
            // unverified layout state. Do NOT under-count by treating it as 0
            // (null is not zero) -- return NaN so measure() skips this element,
            // matching the whole-element offsetHeight skip.
            if (typeof t !== 'number' || !isFinite(t)) return NaN;
            top += t;
            node = node.offsetParent;
        }
        return top;
    }

    /**
     * Recomputes all bounds. Read-only with respect to layout (a single batched
     * reflow), so it does not thrash. Call on load and on resize.
     *
     * Default source is the offsetTop chain + offsetHeight (transform-immune).
     * options.measure === 'rect' selects the legacy getBoundingClientRect source,
     * kept only as a test-only control.
     */
    measure() {
        const win = this.win;
        if (!win) return;

        const scrollY = win.scrollY || win.pageYOffset || 0;
        const viewportHeight = win.innerHeight;
        const elements = this.elements;
        const bounds = this.bounds;
        const rectMode = this._measure === 'rect';

        for (let i = 0; i < this.count; i++) {
            const el = elements[i];
            if (!el) continue;

            let absoluteTop;
            let height;

            if (rectMode) {
                // Legacy path: transform-polluted, reproduces the v1.0.0 bug.
                const rect = el.getBoundingClientRect();
                absoluteTop = rect.top + scrollY;
                height = rect.height;
            } else {
                // Fail closed: a missing or non-finite offsetHeight is an
                // unverified layout state. Do NOT fabricate a zero (null is not
                // zero) -- skip the element and leave its prior bounds intact.
                height = el.offsetHeight;
                if (typeof height !== 'number' || !isFinite(height)) continue;
                absoluteTop = this._absoluteTop(el);
                if (!isFinite(absoluteTop)) continue; // non-finite offsetTop chain
            }

            writeIntersectionBounds(bounds, i * 2, absoluteTop, height, viewportHeight);
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
