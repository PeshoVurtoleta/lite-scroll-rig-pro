// test/browser/scenarios.mjs
//
// Scroll-rig page fixture + interaction scenarios for the browser lane. The
// page loads the REAL rig (src/index.js and its ecosystem siblings) as ES
// modules served from disk through an in-page import map -- no bundler. Input is
// driven as TRUSTED CDP events (wheel / keyboard / touch), the only kind the
// rig's listeners honor. Each scenario leaves the page settled before returning.
//
// The deterministic keyframe pool (POOL) is defined identically here and in the
// page module, so the headless oracle can recompute the exact matrix3d the real
// DOMBinder wrote to element.style.transform. Nothing is scroll-rig-private in
// runner.mjs; everything package-specific lives here and in the *.test/alloc
// callers.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = normalize(join(HERE, '..', '..')); // package root

export const ORIGIN = 'http://scroll-rig.test';
export const PAGE_URL = ORIGIN + '/index.html';

// Deterministic pool: row (i*4 + k). k=0 tx, k=1 ty, k=2 scale, k=3 rotZ.
// tx = 0; ty = TY_PX * t; scale = 1 - SCALE_DROP * t; rotZ = 0. Mirrored in-page.
export const POOL = { TY_PX: -120, SCALE_DROP: 0.2 };

export const SECTION_COUNT = 4;
export const SECTION_H = 400;   // px
export const SECTION_GAP = 600; // px between section tops
export const VIEWPORT = { width: 800, height: 600 };

// The page module: builds the DOM, wires the real rig, exposes probes on window.
// POOL constants are embedded so the page math is byte-identical to the oracle's.
function appModule() {
    return `
import { ScrollEngine, DOMScroller } from '/pkg/src/index.js';

const TY_PX = ${POOL.TY_PX};
const SCALE_DROP = ${POOL.SCALE_DROP};
const N = ${SECTION_COUNT};
const H = ${SECTION_H};
const GAP = ${SECTION_GAP};

// Deterministic, allocation-free pool. row & 3 selects the track.
const pool = {
  eval(row, t) {
    const k = row & 3;
    if (k === 0) return 0;
    if (k === 1) return TY_PX * t;
    if (k === 2) return 1 - SCALE_DROP * t;
    return 0;
  }
};

const spacer = document.createElement('div');
spacer.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:' + (GAP * N + H + 1200) + 'px;';
document.body.appendChild(spacer);

const els = [];
for (let i = 0; i < N; i++) {
  const el = document.createElement('div');
  el.className = 'section';
  el.style.cssText =
    'position:absolute;left:20px;width:300px;height:' + H + 'px;' +
    'top:' + (800 + i * GAP) + 'px;background:#4477ff;will-change:transform;';
  document.body.appendChild(el);
  els.push(el);
}

// A control DOMScroller measuring via the legacy gBCR source ('rect'): it
// reproduces the v1.0.0 transform pollution so the oracle can prove SR-01 in
// vivo. It renders nothing to the DOM (noop binder), it only measures.
const noopBinder = { updateDOMTransforms() {}, invalidate() {}, destroy() {} };
const dsRect = new DOMScroller(els, pool, { measure: 'rect', binder: noopBinder });

const ds = new DOMScroller(els, pool, { observe: true });
const engine = new ScrollEngine(window, {});
engine.addRenderer(ds);
engine.start();

window.__rig = {
  engine, ds, dsRect, els,
  // Re-measure both caches (the RO reality check drives this after a transform
  // is live, then compares the offsetTop truth against the polluted gBCR read).
  remeasure() { ds.cache.measure(); dsRect.cache.measure(); },
  boundsDefault() { return Array.from(ds.cache.bounds); },
  boundsRect() { return Array.from(dsRect.cache.bounds); },
  transforms() {
    return els.map((el) => el.style.transform || '');
  }
};
`;
}

function indexHtml() {
    // Import map points every bare ecosystem specifier at its disk entry file;
    // nested bare imports (spring -> lite-lerp) resolve through the same map.
    const map = {
        imports: {
            '@zakkster/lite-spring': '/pkg/node_modules/@zakkster/lite-spring/Spring.js',
            '@zakkster/lite-gesture': '/pkg/node_modules/@zakkster/lite-gesture/GestureTracker.js',
            '@zakkster/lite-keyframe': '/pkg/node_modules/@zakkster/lite-keyframe/Keyframe.js',
            '@zakkster/lite-dom-binder': '/pkg/node_modules/@zakkster/lite-dom-binder/DOMBinder.js',
            '@zakkster/lite-lerp': '/pkg/node_modules/@zakkster/lite-lerp/Lerp.js'
        }
    };
    return '<!doctype html><html><head><meta charset="utf-8">' +
        '<script type="importmap">' + JSON.stringify(map) + '</' + 'script>' +
        '<style>html,body{margin:0}</style></head><body>' +
        '<script type="module" src="/app.js"></' + 'script>' +
        '</body></html>';
}

const JS_MIME = 'application/javascript; charset=utf-8';

// Route function for runScenarios.routes: serves the generated HTML/app module
// and every /pkg/* path from disk with the JS MIME type. Fail-closed: an
// unreadable /pkg path returns null (Chromium 404s the module and the lane fails
// loudly), never a fabricated empty body.
export function makeRoutes() {
    return function (url) {
        let path;
        try { path = new URL(url).pathname; } catch (_e) { return null; }
        if (path === '/index.html' || path === '/') {
            return { body: indexHtml(), contentType: 'text/html; charset=utf-8' };
        }
        if (path === '/app.js') {
            return { body: appModule(), contentType: JS_MIME };
        }
        if (path.indexOf('/pkg/') === 0) {
            const rel = path.slice('/pkg/'.length);
            // Contain the read to the package root -- no path traversal.
            const abs = normalize(join(ROOT, rel));
            if (abs.indexOf(ROOT) !== 0) return null;
            try {
                return { body: readFileSync(abs, 'utf8'), contentType: JS_MIME };
            } catch (_e) {
                return null;
            }
        }
        return null;
    };
}

// --- headless oracle: recompute the exact matrix3d for (bounds, currentY) -----
// Mirrors DOMScroller.render byte-for-byte: t = clamp(inverseLerp(enter,exit,
// currentY),0,1); pool.eval; composeMatrix2D. Uses the SAME src exports the page
// runs, so a divergence is a real bug, not a reimplementation drift.
export function expectedMatrix(composeMatrix2D, clamp, inverseLerp, enterY, exitY, currentY) {
    const t = clamp(inverseLerp(enterY, exitY, currentY), 0, 1);
    const tx = 0;
    const ty = POOL.TY_PX * t;
    const scale = 1 - POOL.SCALE_DROP * t;
    const rotZ = 0;
    const out = new Float32Array(16);
    composeMatrix2D(out, 0, tx, ty, 0, scale, scale, rotZ);
    return out;
}

// Parse a `matrix3d(...)` string into 16 numbers, or null if it is not one.
export function parseMatrix3d(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/matrix3d\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',');
    if (parts.length !== 16) return null;
    const out = new Array(16);
    for (let i = 0; i < 16; i++) {
        const v = parseFloat(parts[i]);
        if (v !== v) return null; // fail closed on an unparseable component
        out[i] = v;
    }
    return out;
}

// Probes captured mid-run (read by the oracle after the scenarios finish).
export const roProbe = { beforeDefault: null, afterDefault: null, beforeRect: null, afterRect: null };

const CENTER_X = 160;
const CENTER_Y = 300;

export const SCENARIOS = [
    {
        // Wheel-scroll a few hundred px, settle, snapshot currentY + transforms.
        name: 'wheel',
        async run(ctx) {
            for (let i = 0; i < 12; i++) { await ctx.wheel(CENTER_X, CENTER_Y, 120); await ctx.frame(); }
            for (let i = 0; i < 40; i++) await ctx.frame(); // let the spring settle
        }
    },
    {
        // Keyboard: PageDown a few times (the rig owns the window, so it steps
        // targetY and preventDefaults the native scroll).
        name: 'keyboard',
        async run(ctx) {
            for (let i = 0; i < 4; i++) { await ctx.key('PageDown', 'PageDown'); await ctx.frame(); }
            for (let i = 0; i < 40; i++) await ctx.frame();
        }
    },
    {
        // Touch: a vertical drag up scrolls content down (inverted), via the real
        // GestureTracker pan path.
        name: 'touch',
        async run(ctx) {
            await ctx.touch(CENTER_X, 500, 100, 10);
            for (let i = 0; i < 40; i++) await ctx.frame();
        }
    },
    {
        // RO reality check (SR-01 in vivo). With transforms live on the elements,
        // re-measure both caches. The offsetTop source must be transform-immune
        // (bounds unchanged); the legacy gBCR 'rect' control must drift.
        name: 'ro-remeasure',
        async run(ctx) {
            for (let i = 0; i < 12; i++) { await ctx.wheel(CENTER_X, CENTER_Y, 120); await ctx.frame(); }
            for (let i = 0; i < 20; i++) await ctx.frame();
            const before = await ctx.eval(function () {
                return { d: window.__rig.boundsDefault(), r: window.__rig.boundsRect() };
            });
            // Re-measure while transforms are live (the pollution trigger).
            await ctx.eval(function () { window.__rig.remeasure(); });
            const after = await ctx.eval(function () {
                return { d: window.__rig.boundsDefault(), r: window.__rig.boundsRect() };
            });
            roProbe.beforeDefault = before.d;
            roProbe.afterDefault = after.d;
            roProbe.beforeRect = before.r;
            roProbe.afterRect = after.r;
        }
    }
];

export function collectSnapshot(page) {
    return page.evaluate(function () {
        const rig = window.__rig;
        return {
            currentY: rig.engine.currentY,
            isParked: rig.engine.isParked,
            bounds: rig.boundsDefault(),
            transforms: rig.transforms()
        };
    });
}
