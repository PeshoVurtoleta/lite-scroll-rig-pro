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

/**
 * Package version, string-synced to package.json. Copied inline -- nothing at
 * runtime reads it; the release gate asserts VERSION === package.json.version
 * by exact string compare, so this line is a version site.
 */
export const VERSION = '1.2.0';
