// test/browser/oracle.test.mjs -- node --test test/browser/oracle.test.mjs
//
// THE DOM ORACLE. Runs the real rig in one real Chromium, drives trusted
// wheel / keyboard / touch, and asserts the transform the real DOMBinder wrote
// to element.style.transform matches the headless recomputation from the SAME
// src math at the rig's reported currentY -- the fakes prove the math, this
// proves the DOM. Then it re-measures under a live transform and asserts the
// shipped offsetTop source is transform-immune (SR-01 fixed) while the v1.0.0
// gBCR control drifts -- teeth.
//
// Browser policy: FAIL-CLOSED. Missing Chromium is a failure, NOT a skip, unless
// LITE_NO_BROWSER=1, in which case this lane skips loudly and the Node lanes gate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runScenarios } from './runner.mjs';
import {
    SCENARIOS, PAGE_URL, VIEWPORT, makeRoutes, collectSnapshot,
    expectedMatrix, parseMatrix3d, roProbe
} from './scenarios.mjs';
import { maxAbsDelta } from './control.v100.mjs';

import { composeMatrix2D } from '../../src/index.js';
import { clamp, inverseLerp } from '@zakkster/lite-lerp';

const SKIP = process.env.LITE_NO_BROWSER === '1';
const MATRIX_TOL = 0.02;   // px / unitless: Float32 + CSSOM serialization budget
const RECT_DRIFT_MIN = 5;  // px: the gBCR control must drift at least this much
const DEFAULT_DRIFT_MAX = 0.5; // px: the offsetTop source must not drift

if (SKIP) console.log('[oracle] LITE_NO_BROWSER=1 -- browser lane SKIPPED (Node lanes still gate).');

test('DOM transforms match headless math across wheel / keyboard / touch', { skip: SKIP }, async () => {
    const results = await runScenarios({
        pageUrl: PAGE_URL,
        routes: makeRoutes(),
        inject: async function () {},
        scenarios: SCENARIOS,
        collect: collectSnapshot,
        options: { headless: true, viewport: VIEWPORT, onLog: function (s) { console.log('  [runner] ' + s); } }
    });

    assert.equal(results.length, SCENARIOS.length,
        'expected ' + SCENARIOS.length + ' scenario results, got ' + results.length);

    for (const r of results) {
        if (r.name === 'ro-remeasure') continue; // asserted below via probes
        const s = r.snapshot;
        console.log('  ' + r.name.padEnd(12) + ' currentY=' + fmt(s.currentY) +
            ' parked=' + s.isParked + ' sections=' + s.transforms.length);

        // Teeth: the input must actually have moved the rig off its start.
        assert.ok(s.currentY > 1,
            r.name + ': currentY did not advance (' + fmt(s.currentY) + ') -- input was not applied');

        let anyNonIdentity = false;
        for (let i = 0; i < s.transforms.length; i++) {
            const got = parseMatrix3d(s.transforms[i]);
            assert.ok(got !== null,
                r.name + ' el ' + i + ': style.transform was not a parseable matrix3d ("' + s.transforms[i] + '")');
            const enterY = s.bounds[i * 2];
            const exitY = s.bounds[i * 2 + 1];
            const want = expectedMatrix(composeMatrix2D, clamp, inverseLerp, enterY, exitY, s.currentY);
            for (let k = 0; k < 16; k++) {
                const d = Math.abs(got[k] - want[k]);
                assert.ok(d <= MATRIX_TOL,
                    r.name + ' el ' + i + ' m[' + k + ']: DOM ' + got[k] +
                    ' vs headless ' + want[k] + ' (delta ' + d.toFixed(4) + ' > ' + MATRIX_TOL + ')');
            }
            // m[13] is translateY; a scrolled-past section has a non-zero one.
            if (Math.abs(got[13]) > MATRIX_TOL || Math.abs(got[0] - 1) > MATRIX_TOL) anyNonIdentity = true;
        }
        assert.ok(anyNonIdentity, r.name + ': every section stayed at identity -- nothing animated');
    }
});

test('SR-01 in vivo: offsetTop source is transform-immune; gBCR control drifts', { skip: SKIP }, async () => {
    // The ro-remeasure scenario ran in the first test's browser session and filled
    // roProbe. Re-run just that scenario so this test is independent.
    await runScenarios({
        pageUrl: PAGE_URL,
        routes: makeRoutes(),
        inject: async function () {},
        scenarios: [SCENARIOS[SCENARIOS.length - 1]],
        collect: collectSnapshot,
        options: { headless: true, viewport: VIEWPORT, onLog: function (s) { console.log('  [runner] ' + s); } }
    });

    assert.ok(roProbe.beforeDefault && roProbe.afterDefault, 'ro-remeasure did not capture default bounds');
    assert.ok(roProbe.beforeRect && roProbe.afterRect, 'ro-remeasure did not capture rect bounds');

    const defaultDrift = maxAbsDelta(roProbe.beforeDefault, roProbe.afterDefault);
    const rectDrift = maxAbsDelta(roProbe.beforeRect, roProbe.afterRect);
    console.log('  offsetTop drift=' + defaultDrift.toFixed(3) + 'px  gBCR(v1.0.0) drift=' + rectDrift.toFixed(3) + 'px');

    assert.ok(defaultDrift <= DEFAULT_DRIFT_MAX,
        'offsetTop source drifted ' + defaultDrift.toFixed(3) + 'px under a live transform (budget ' + DEFAULT_DRIFT_MAX + 'px)');
    assert.ok(rectDrift >= RECT_DRIFT_MIN,
        'v1.0.0 gBCR control should drift >= ' + RECT_DRIFT_MIN + 'px under a live transform, got ' +
        rectDrift.toFixed(3) + 'px -- the SR-01 control has no teeth');
});

function fmt(v) { return v === null || v === undefined ? 'null' : (Math.round(v * 10) / 10); }
