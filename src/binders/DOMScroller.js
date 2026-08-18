/**
 * DOMScroller.js
 *
 * The render half of the rig. Each frame it maps every element's scroll
 * progress to a keyframed transform and pushes a batch of matrices to the DOM.
 *
 * Per element, per frame:
 *   1. progress t = clamp(inverseLerp(enterY, exitY, currentY), 0, 1)
 *      (bounds come pre-measured from MetricsCache -- no layout reads here)
 *   2. four keyframe tracks evaluated at t -> [tx, ty, scale, rotZ]
 *   3. composeMatrix2D writes a matrix3d into a shared Float32Array
 *   4. DOMBinder flushes the whole buffer in one pass
 *
 * Track layout is fixed at 4 rows per element in the pool:
 *   row (i*4 + 0) = translateX
 *   row (i*4 + 1) = translateY
 *   row (i*4 + 2) = scale (uniform)
 *   row (i*4 + 3) = rotateZ (degrees)
 *
 * The loop allocates nothing. The DOM binder is injectable, and the cache's
 * ResizeObserver options are forwarded so element size changes invalidate the
 * binder automatically.
 *
 * MIT License (c) Zahary Shinikchiev
 */

import { DOMBinder } from '@zakkster/lite-dom-binder';
import { clamp, inverseLerp } from '@zakkster/lite-lerp';
import { composeMatrix2D } from './MatrixComposer.js';
import { MetricsCache } from '../spatial/MetricsCache.js';

const TRACKS_PER_ENTITY = 4;
const FLOATS_PER_MATRIX = 16;

export class DOMScroller {
    /**
     * @param {Array<HTMLElement>} elements - the elements to animate
     * @param {object} pool - a KeyframePool (needs eval(rowIdx, t)); must hold
     *                 elements.length * 4 rows in [tx, ty, scale, rotZ] order
     * @param {object} [options]
     * @param {object}  [options.binder] - DOMBinder-like (DI)
     * @param {Window}  [options.win] - forwarded to MetricsCache
     * @param {boolean} [options.observe=false] - auto-invalidate on element resize
     * @param {Function}[options.ResizeObserverCtor] - forwarded to MetricsCache
     * @param {string}  [options.measure] - forwarded to MetricsCache ('rect' =
     *                  legacy gBCR source; test-only control)
     */
    constructor(elements, pool, options = {}) {
        this.elements = elements;
        this.count = elements.length;
        this.pool = pool;
        this.matrices = new Float32Array(this.count * FLOATS_PER_MATRIX);
        this.binder = options.binder || new DOMBinder(this.count);

        // Wake seam (SR-05): ScrollEngine.addRenderer assigns its bound wake() here
        // so a ResizeObserver firing on a late image load can wake a parked loop
        // and render the re-measured bounds. Null until wired; cold path.
        this._onInvalidate = null;

        this.cache = new MetricsCache(elements, options.win, {
            observe: !!options.observe,
            ResizeObserverCtor: options.ResizeObserverCtor,
            measure: options.measure,
            onResize: () => this._invalidate()
        });
    }

    _invalidate() {
        if (this.binder && typeof this.binder.invalidate === 'function') this.binder.invalidate();
        if (this._onInvalidate) this._onInvalidate();
    }

    /** Re-measure and force a transform re-push. Call on resize. */
    resize() {
        this.cache.measure();
        this._invalidate();
    }

    render(currentY) {
        const bounds = this.cache.bounds;
        const pool = this.pool;
        const matrices = this.matrices;
        const count = this.count;

        for (let i = 0; i < count; i++) {
            const b = i * 2;
            const t = clamp(inverseLerp(bounds[b], bounds[b + 1], currentY), 0, 1);

            const track = i * TRACKS_PER_ENTITY;
            const tx = pool.eval(track, t);
            const ty = pool.eval(track + 1, t);
            const scale = pool.eval(track + 2, t);
            const rotZ = pool.eval(track + 3, t);

            composeMatrix2D(matrices, i * FLOATS_PER_MATRIX, tx, ty, 0, scale, scale, rotZ);
        }

        this.binder.updateDOMTransforms(this.elements, matrices, count);
    }

    destroy() {
        if (!this.cache) return; // idempotent: a second call is a no-op
        this.cache.destroy();
        if (this.binder && typeof this.binder.destroy === 'function') this.binder.destroy();
        this.elements = null;
        this.pool = null;
        this.binder = null;
        this.matrices = null;
        this.cache = null;
        this._onInvalidate = null;
    }
}
