/**
 * MatrixComposer.js
 *
 * Fused TRS (translate / rotate / scale) composition for 2.5D scroll
 * animations, written directly into a column-major Float32Array stride that
 * feeds straight into a CSS matrix3d() (or a WebGL attribute buffer).
 *
 * Zero allocation: the caller owns the output buffer; this only writes 16
 * floats at the given offset. Inputs are assumed finite -- like the rest of
 * the hot-path surface in this ecosystem, there are no defensive checks here.
 *
 * MIT License (c) Zahary Shinikchiev
 */

const DEG_TO_RAD = Math.PI / 180;

/**
 * Composes a CSS3D matrix for the common case: translate X/Y/Z, uniform or
 * non-uniform scale X/Y, and rotation about Z. Covers essentially all
 * scroll-triggered DOM transforms.
 *
 * Layout written (column-major, matrix3d order):
 *   | c*sx  -s*sy  0  tx |
 *   | s*sx   c*sy  0  ty |
 *   |   0      0   1  tz |
 *   |   0      0   0   1 |
 *
 * @param {Float32Array} outBuf - destination buffer (length >= offset + 16)
 * @param {number} offset - start index, typically entityIndex * 16
 * @param {number} tx - translate X (px)
 * @param {number} ty - translate Y (px)
 * @param {number} tz - translate Z (px; non-zero forces a GPU layer)
 * @param {number} sx - scale X
 * @param {number} sy - scale Y
 * @param {number} rz - rotation about Z (degrees)
 */
export const composeMatrix2D = (outBuf, offset, tx, ty, tz, sx, sy, rz) => {
    const rad = rz * DEG_TO_RAD;
    const c = Math.cos(rad);
    const s = Math.sin(rad);

    // Column 0: scaled/rotated X axis
    outBuf[offset]     = c * sx;
    outBuf[offset + 1] = s * sx;
    outBuf[offset + 2] = 0;
    outBuf[offset + 3] = 0;

    // Column 1: scaled/rotated Y axis
    outBuf[offset + 4] = -s * sy;
    outBuf[offset + 5] = c * sy;
    outBuf[offset + 6] = 0;
    outBuf[offset + 7] = 0;

    // Column 2: Z axis (identity for 2.5D)
    outBuf[offset + 8]  = 0;
    outBuf[offset + 9]  = 0;
    outBuf[offset + 10] = 1;
    outBuf[offset + 11] = 0;

    // Column 3: translation
    outBuf[offset + 12] = tx;
    outBuf[offset + 13] = ty;
    outBuf[offset + 14] = tz;
    outBuf[offset + 15] = 1;
};
