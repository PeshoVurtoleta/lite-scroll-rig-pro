/**
 * MathMap.test.js
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    writeIntersectionBounds,
    calculateIntersectionBounds,
    computeProgress,
    computeParallaxOffset
} from '../src/spatial/MathMap.js';

test('calculateIntersectionBounds matches the documented example', () => {
    // Element at Y=1000, height=200, viewport 800 high.
    const b = calculateIntersectionBounds(1000, 200, 800);
    assert.equal(b[0], 200);  // top (1000) hits viewport bottom (800)
    assert.equal(b[1], 1200); // bottom (1200) hits viewport top (0)
});

test('enterY clamps to 0 for elements near the document top', () => {
    const b = calculateIntersectionBounds(100, 50, 800);
    assert.equal(b[0], 0);    // 100 - 800 = -700 -> clamped
    assert.equal(b[1], 150);
});

test('inverted bounds are forbidden (exit >= enter)', () => {
    // Contrive negative height so exit would precede enter.
    const b = calculateIntersectionBounds(1000, -5000, 800);
    assert.equal(b[1], b[0]); // clamped up to enter
});

test('offsets shift enter and exit points', () => {
    const b = calculateIntersectionBounds(1000, 200, 800, 50, -30);
    assert.equal(b[0], 250);  // 200 + 50
    assert.equal(b[1], 1170); // 1200 - 30
});

test('writeIntersectionBounds writes at offset with zero allocation', () => {
    const buf = new Float32Array(4); // two entities
    writeIntersectionBounds(buf, 0, 1000, 200, 800);
    writeIntersectionBounds(buf, 2, 2000, 100, 800);
    assert.equal(buf[0], 200);
    assert.equal(buf[1], 1200);
    assert.equal(buf[2], 1200); // 2000 - 800
    assert.equal(buf[3], 2100); // 2000 + 100
});

test('writeIntersectionBounds and calculateIntersectionBounds agree', () => {
    const buf = new Float32Array(2);
    writeIntersectionBounds(buf, 0, 1234, 321, 768, 12, -7);
    const b = calculateIntersectionBounds(1234, 321, 768, 12, -7);
    assert.equal(buf[0], b[0]);
    assert.equal(buf[1], b[1]);
});

test('computeProgress clamps and centers correctly', () => {
    assert.equal(computeProgress(100, 200, 1200), 0);   // before enter
    assert.equal(computeProgress(700, 200, 1200), 0.5); // dead center
    assert.equal(computeProgress(1500, 200, 1200), 1);  // after exit
    assert.equal(computeProgress(450, 200, 1200), 0.25);
});

test('computeProgress is safe for a zero-width range', () => {
    assert.equal(computeProgress(500, 500, 500), 0); // currentY <= startY
    assert.equal(computeProgress(600, 500, 500), 1); // currentY >= endY
});

test('computeParallaxOffset is symmetric around 0.5', () => {
    assert.equal(computeParallaxOffset(0, 100), 100);
    assert.equal(computeParallaxOffset(0.5, 100), 0);
    assert.equal(computeParallaxOffset(1, 100), -100);
});
