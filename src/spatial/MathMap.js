/**
 * MathMap.js
 *
 * Pure spatial math for scroll mapping: where an element intersects the
 * viewport, how far through that range the scroll currently is, and parallax
 * offsets. One formula for intersection bounds, shared by every caller
 * (MetricsCache included) so the hot path and the convenience helper can
 * never disagree.
 *
 * MIT License (c) Zahary Shinikchiev
 */

/**
 * Writes an element's [enterY, exitY] scroll bounds into a caller-owned buffer.
 * Zero allocation -- this is the single source of truth for the formula.
 *
 *   enterY: scroll position where the element's top reaches the viewport
 *           bottom (clamped to >= 0).
 *   exitY:  scroll position where the element's bottom reaches the viewport
 *           top (clamped to >= enterY to forbid inverted ranges).
 *
 * @param {Float32Array} outBuf - destination (length >= offset + 2)
 * @param {number} offset - start index, typically entityIndex * 2
 * @param {number} absoluteTop - element top in absolute document Y (px)
 * @param {number} height - element height (px)
 * @param {number} viewportHeight - window innerHeight (px)
 * @param {number} [offsetStart=0] - shift the enter point (px)
 * @param {number} [offsetEnd=0] - shift the exit point (px)
 */
export const writeIntersectionBounds = (outBuf, offset, absoluteTop, height, viewportHeight, offsetStart = 0, offsetEnd = 0) => {
    let startY = (absoluteTop - viewportHeight) + offsetStart;
    if (startY < 0) startY = 0;

    let endY = (absoluteTop + height) + offsetEnd;
    if (endY < startY) endY = startY;

    outBuf[offset] = startY;
    outBuf[offset + 1] = endY;
};

/**
 * Allocating convenience around writeIntersectionBounds. Returns a fresh
 * 2-element Float32Array [enterY, exitY]. Use at setup/measure time, NOT in
 * per-frame loops -- it allocates.
 *
 * @returns {Float32Array} [enterY, exitY]
 */
export const calculateIntersectionBounds = (absoluteTop, height, viewportHeight, offsetStart = 0, offsetEnd = 0) => {
    const out = new Float32Array(2);
    writeIntersectionBounds(out, 0, absoluteTop, height, viewportHeight, offsetStart, offsetEnd);
    return out;
};

/**
 * Normalizes the current scroll position to a strictly clamped [0, 1] progress
 * across an element's [startY, endY] range. The early returns also make a
 * zero-width range safe (no division by zero).
 *
 * @param {number} currentY - current smoothed scroll position
 * @param {number} startY - range start
 * @param {number} endY - range end
 * @returns {number} progress in [0, 1]
 */
export const computeProgress = (currentY, startY, endY) => {
    if (currentY <= startY) return 0;
    if (currentY >= endY) return 1;
    return (currentY - startY) / (endY - startY);
};

/**
 * Maps [0, 1] progress to a symmetric parallax offset: progress 0 yields
 * +intensity, 0.5 yields 0 (centered), 1 yields -intensity.
 *
 * @param {number} progress - normalized [0, 1]
 * @param {number} intensity - half of the total pixel travel
 * @returns {number} pixel offset
 */
export const computeParallaxOffset = (progress, intensity) => {
    return intensity - (progress * intensity * 2);
};
