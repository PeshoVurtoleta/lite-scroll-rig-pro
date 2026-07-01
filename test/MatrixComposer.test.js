/**
 * MatrixComposer.test.js
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeMatrix2D } from '../src/binders/MatrixComposer.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('identity-ish: no rotation, unit scale, with translation', () => {
    const buf = new Float32Array(16);
    composeMatrix2D(buf, 0, 100, 50, 10, 1, 1, 0);

    assert.equal(buf[0], 1);   // c*sx
    assert.equal(buf[1], 0);   // s*sx
    assert.equal(buf[5], 1);   // c*sy
    assert.equal(buf[10], 1);  // z identity
    assert.equal(buf[12], 100);
    assert.equal(buf[13], 50);
    assert.equal(buf[14], 10);
    assert.equal(buf[15], 1);
});

test('scale is applied to the axis columns', () => {
    const buf = new Float32Array(16);
    composeMatrix2D(buf, 0, 0, 0, 0, 2, 3, 0);
    assert.equal(buf[0], 2); // sx
    assert.equal(buf[5], 3); // sy
});

test('90-degree rotation maps axes correctly', () => {
    const buf = new Float32Array(16);
    composeMatrix2D(buf, 0, 0, 0, 0, 1, 1, 90);
    // c=0, s=1
    assert.ok(close(buf[0], 0));   // c*sx
    assert.ok(close(buf[1], 1));   // s*sx
    assert.ok(close(buf[4], -1));  // -s*sy
    assert.ok(close(buf[5], 0));   // c*sy
});

test('180-degree rotation negates the axes', () => {
    const buf = new Float32Array(16);
    composeMatrix2D(buf, 0, 0, 0, 0, 1, 1, 180);
    assert.ok(close(buf[0], -1));
    assert.ok(close(buf[5], -1));
    assert.ok(close(buf[1], 0));
    assert.ok(close(buf[4], 0));
});

test('rotation composes with non-uniform scale', () => {
    const buf = new Float32Array(16);
    composeMatrix2D(buf, 0, 0, 0, 0, 2, 4, 90);
    // c=0,s=1: col0=[0, 1*2], col1=[-1*4, 0]
    assert.ok(close(buf[0], 0));
    assert.ok(close(buf[1], 2));
    assert.ok(close(buf[4], -4));
    assert.ok(close(buf[5], 0));
});

test('writes at a non-zero offset without touching the first entity', () => {
    const buf = new Float32Array(32); // two entities
    composeMatrix2D(buf, 0, 1, 2, 3, 1, 1, 0);
    composeMatrix2D(buf, 16, 7, 8, 9, 1, 1, 0);

    assert.equal(buf[12], 1); // entity 0 translation intact
    assert.equal(buf[13], 2);
    assert.equal(buf[14], 3);

    assert.equal(buf[16 + 12], 7); // entity 1 translation
    assert.equal(buf[16 + 13], 8);
    assert.equal(buf[16 + 14], 9);
    assert.equal(buf[16 + 15], 1);
});
