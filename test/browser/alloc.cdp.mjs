// test/browser/alloc.cdp.mjs -- node test/browser/alloc.cdp.mjs
//
// In-browser allocation gate. Drives a ~10k-frame scripted wheel scroll through
// the SAME runner seam the oracle uses (real CDP wheel + rAF frames), with the
// REAL rig -- ScrollEngine._tick -> DOMScroller.render -> DOMBinder writing
// matrix3d into element.style.transform. The heap is sampled with CDP
// HeapProfiler around the burst.
//
// The gated signal is renderPath: sampled self-size of the rig's hot frames
// (_tick, render, composeMatrix2D, updateDOMTransforms). That is the honest
// floor -- the frame loop allocates nothing, so its sampled self-size stays
// near zero. Whole-page `total` is logged for context but NOT gated (page/GC
// noise). CONTROL: a second run whose custom renderer allocates a fresh array
// every frame; its renderPath MUST exceed the floor, or the gate has no teeth.
//
// Browser policy: FAIL-CLOSED. Missing Chromium fails the gate, unless
// LITE_NO_BROWSER=1 in which case it skips loudly (exit 0).

import { runScenarios } from './runner.mjs';
import { PAGE_URL, VIEWPORT, makeRoutes } from './scenarios.mjs';

const SKIP = process.env.LITE_NO_BROWSER === '1';
if (SKIP) {
    console.log('[alloc.cdp] LITE_NO_BROWSER=1 -- browser alloc gate SKIPPED (Node lanes still gate).');
    console.log('GATE alloc.cdp SKIPPED (LITE_NO_BROWSER=1)');
    process.exit(0);
}

const FRAMES = 10000;           // scripted scroll frames per run
const WHEEL_EVERY = 20;         // inject a wheel tick every Nth frame (keep it moving)
const WHEEL_DY = 40;
const SAMPLING_INTERVAL = 4096; // bytes; finer than the 32KB default for signal
const RENDER_FLOOR_BYTES = 24 * 1024;  // 24 KiB honest floor for the frame path
const CONTROL_MARGIN = 32 * 1024;      // control must clear the floor by this much
const CENTER_X = 160;
const CENTER_Y = 300;

// The rig's hot-frame call frames. A per-frame object literal in any of these
// would sample above the floor.
const RENDER_FRAMES = new Set(['_tick', 'render', 'composeMatrix2D', 'updateDOMTransforms', 'bound _tick']);

const measured = Object.create(null);

// Install an allocating custom renderer (the control) that churns a fresh array
// every frame, so its render self-size lands far above the honest floor.
function installAllocRenderer() {
    const rig = window.__rig;
    let sink = null;
    const allocRenderer = {
        render() { sink = new Array(4096).fill(0); window.__sink = sink; },
        resize() {}
    };
    rig.engine.addRenderer(allocRenderer);
}

function makeScenario(name, allocating) {
    return {
        name: name,
        async run(ctx) {
            if (allocating) await ctx.eval(installAllocRenderer);
            // Warm one frame, GC, then sample only the burst.
            await ctx.wheel(CENTER_X, CENTER_Y, WHEEL_DY);
            await ctx.frame();
            await ctx.cdp.send('HeapProfiler.enable');
            await ctx.cdp.send('HeapProfiler.collectGarbage');
            await ctx.cdp.send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL });
            for (let i = 0; i < FRAMES; i++) {
                if (i % WHEEL_EVERY === 0) await ctx.wheel(CENTER_X, CENTER_Y, WHEEL_DY);
                await ctx.frame();
            }
            const res = await ctx.cdp.send('HeapProfiler.stopSampling');
            await ctx.cdp.send('HeapProfiler.disable');
            measured[name] = {
                total: sumSamples(res.profile),
                renderBytes: sumRenderPath(res.profile)
            };
        }
    };
}

function collect(page) {
    return page.evaluate(function () {
        return { currentY: window.__rig.engine.currentY };
    });
}

// --- profile reducers -----------------------------------------------------
function sumSamples(profile) {
    let total = 0;
    if (profile.samples && profile.samples.length) {
        for (const s of profile.samples) total += s.size || 0;
        return total;
    }
    return sumSelfSize(profile.head);
}
function sumSelfSize(node) {
    if (!node) return 0;
    let t = node.selfSize || 0;
    if (node.children) for (const c of node.children) t += sumSelfSize(c);
    return t;
}
function sumRenderPath(profile) {
    if (!profile.head) return 0;
    let total = 0;
    (function walk(node) {
        const fn = node.callFrame ? node.callFrame.functionName : '';
        if (RENDER_FRAMES.has(fn)) total += node.selfSize || 0;
        if (node.children) for (const c of node.children) walk(c);
    })(profile.head);
    return total;
}

// --- run ------------------------------------------------------------------
let exitCode = 0;
try {
    const results = await runScenarios({
        pageUrl: PAGE_URL,
        routes: makeRoutes(),
        inject: async function () {},
        scenarios: [makeScenario('honest', false), makeScenario('control', true)],
        collect: collect,
        options: { headless: true, viewport: VIEWPORT, onLog: function (s) { console.log('  [runner] ' + s); } }
    });

    const snap = Object.create(null);
    for (const r of results) snap[r.name] = r.snapshot;
    const honest = { m: measured.honest, s: snap.honest };
    const control = { m: measured.control, s: snap.control };

    if (!honest.m || !control.m) {
        fail('a run did not record a heap sample');
    } else {
        console.log('  honest : total=' + kb(honest.m.total) + ' renderPath=' + kb(honest.m.renderBytes) + ' currentY=' + fmt(honest.s.currentY));
        console.log('  control: total=' + kb(control.m.total) + ' renderPath=' + kb(control.m.renderBytes) + ' currentY=' + fmt(control.s.currentY));
        console.log('  FLOOR(renderPath)=' + kb(RENDER_FLOOR_BYTES) + ' controlMargin>=' + kb(CONTROL_MARGIN));

        if (honest.m.renderBytes === 0 && control.m.renderBytes === 0) {
            fail('both renderPaths sampled 0 -- sampler broken, gate has no teeth');
        }
        if (honest.m.renderBytes > RENDER_FLOOR_BYTES) {
            fail('render path OVER floor: honest renderPath ' + kb(honest.m.renderBytes) + ' > ' + kb(RENDER_FLOOR_BYTES));
        }
        const controlFlagged = control.m.renderBytes > RENDER_FLOOR_BYTES &&
            (control.m.renderBytes - honest.m.renderBytes) >= CONTROL_MARGIN;
        if (!controlFlagged) {
            fail('allocating-renderer control NOT flagged: control renderPath ' +
                kb(control.m.renderBytes) + ' vs honest ' + kb(honest.m.renderBytes) +
                ' (floor ' + kb(RENDER_FLOOR_BYTES) + ', margin ' + kb(CONTROL_MARGIN) + ') -- gate has no teeth');
        }
        if (exitCode === 0) {
            console.log('GATE alloc.cdp honestRenderPath=' + honest.m.renderBytes +
                'B floor=' + RENDER_FLOOR_BYTES + 'B controlRenderPath=' +
                control.m.renderBytes + 'B controlFlagged=true | ok');
        }
    }
} catch (e) {
    console.error('GATE alloc.cdp FAIL: ' + e.message);
    exitCode = 1;
}
process.exit(exitCode);

function fail(msg) { console.error('  FAIL ' + msg); exitCode = 1; }
function kb(b) { return (b / 1024).toFixed(1) + 'KB'; }
function fmt(v) { return v === null || v === undefined ? 'null' : (Math.round(v * 10) / 10); }
