/**
 * @zakkster/lite-scroll-rig-pro
 *
 * Zero-GC scroll-driven transform rig. Public entry point.
 *
 * MIT License (c) Zahary Shinikchiev
 */

export { ScrollEngine } from './core/ScrollEngine.js';
export { VirtualScroll } from './core/VirtualScroll.js';
export { DOMScroller } from './binders/DOMScroller.js';
export { composeMatrix2D } from './binders/MatrixComposer.js';
export { MetricsCache } from './spatial/MetricsCache.js';
export {
    writeIntersectionBounds,
    calculateIntersectionBounds,
    computeProgress,
    computeParallaxOffset
} from './spatial/MathMap.js';
