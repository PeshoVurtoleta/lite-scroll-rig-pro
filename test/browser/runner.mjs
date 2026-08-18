// test/browser/runner.mjs
//
// runScenarios -- the LIFTABLE SEAM (ported from LiteInp, adapted for scroll).
// =================================================================
// Package-agnostic Playwright driver. Nothing here is scroll-rig specific: it
// launches a real Chromium, opens one fresh page per scenario, lets the CALLER
// instrument the page (`inject`), lets each SCENARIO drive real trusted input
// (`run`), then lets the caller read a JSON snapshot (`collect`).
//
// Two additions over the lite-inp original, both generic:
//   - routes may return { body, contentType } (not just an HTML string), so a
//     caller can serve ES modules from disk with the correct JS MIME type -- the
//     scroll lane loads the real rig this way via an in-page import map.
//   - ctx gains wheel(), key(), and touch() (CDP Input.* dispatchers) alongside
//     tap(), because a scroll rig is driven by wheel / keyboard / touch, not
//     clicks. All are trusted input (the only kind the rig's listeners honor).
//
// SEAM CONTRACT
//   runScenarios({ pageUrl, inject, scenarios, collect, routes, options })
//     -> Promise<Result[]>
//
// ctx (handed to inject, run, collect) -- generic browser primitives only:
//   ctx.page              Playwright Page.
//   ctx.cdp               Attached CDP session.
//   ctx.tap(x, y)         One trusted left click at (x, y).
//   ctx.wheel(x, y, dy)   One trusted wheel tick (deltaY = dy) at (x, y).
//   ctx.key(code, key)    One trusted keydown+keyup (e.g. 'ArrowDown').
//   ctx.touch(x, y0, y1, steps)  A trusted vertical touch drag from y0 to y1.
//   ctx.frame()           Await two rAFs (one painted frame boundary).
//   ctx.wait(ms)          Await ms of wall time in the page.
//   ctx.eval(fn, ...args) page.evaluate passthrough.
//   ctx.goto(url)/ctx.back()  Navigate (uses config.routes when set).
//   ctx.log(s)            options.onLog passthrough.
// =================================================================

import { chromium } from 'playwright';

export async function runScenarios(config) {
    const pageUrl = config.pageUrl || 'about:blank';
    const inject = config.inject;
    const scenarios = config.scenarios || [];
    const collect = config.collect;
    const routes = config.routes || null;
    const options = config.options || {};
    const headless = options.headless !== false;
    const viewport = options.viewport || { width: 800, height: 600 };
    const onLog = typeof options.onLog === 'function' ? options.onLog : function () {};

    if (typeof inject !== 'function') throw new Error('runScenarios: inject must be a function');
    if (typeof collect !== 'function') throw new Error('runScenarios: collect must be a function');

    const browser = await chromium.launch({ headless: headless });
    const results = [];
    try {
        for (let i = 0; i < scenarios.length; i++) {
            const scenario = scenarios[i];
            const page = await browser.newPage({ viewport: viewport });
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Input.setIgnoreInputEvents', { ignore: false }).catch(function () {});

            if (routes !== null) await registerRoutes(page, routes);

            const ctx = makeCtx(page, cdp, onLog);

            await page.goto(pageUrl);
            await inject(page, ctx);
            onLog('scenario ' + scenario.name + ': injected');
            await scenario.run(ctx);
            const snapshot = await collect(page, ctx);
            onLog('scenario ' + scenario.name + ': collected');
            results.push({ name: scenario.name, snapshot: snapshot });

            await cdp.detach().catch(function () {});
            await page.close();
        }
    } finally {
        await browser.close();
    }
    return results;
}

function makeCtx(page, cdp, onLog) {
    async function tap(x, y) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none', buttons: 0 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1 });
    }
    async function wheel(x, y, dy) {
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: x, y: y, deltaX: 0, deltaY: dy
        });
    }
    async function key(code, keyName) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: code, key: keyName });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: code, key: keyName });
    }
    async function touch(x, y0, y1, steps) {
        const n = steps || 8;
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart', touchPoints: [{ x: x, y: y0 }]
        });
        for (let i = 1; i <= n; i++) {
            const y = y0 + (y1 - y0) * (i / n);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x, y: y }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    function frame() {
        return page.evaluate(function () {
            return new Promise(function (r) {
                requestAnimationFrame(function () { requestAnimationFrame(function () { r(); }); });
            });
        });
    }
    function wait(ms) {
        return page.evaluate(function (m) {
            return new Promise(function (r) { setTimeout(r, m); });
        }, ms);
    }
    function goto(url) { return page.goto(url); }
    function back() { return page.goBack(); }
    return {
        page: page,
        cdp: cdp,
        tap: tap,
        wheel: wheel,
        key: key,
        touch: touch,
        frame: frame,
        wait: wait,
        goto: goto,
        back: back,
        eval: function (fn) {
            const args = Array.prototype.slice.call(arguments, 1);
            return page.evaluate(fn, ...args);
        },
        log: onLog
    };
}

// Register in-memory routes. A route entry may be an HTML string OR an object
// { body, contentType } (so ES modules can be served with the JS MIME type).
// `routes` is either a { url: entry } map or a function (url) -> entry|null.
async function registerRoutes(page, routes) {
    const lookup = typeof routes === 'function'
        ? routes
        : function (url) {
            if (routes[url] !== undefined) return routes[url];
            for (const key in routes) {
                if (url.indexOf(key) !== -1) return routes[key];
            }
            return null;
        };
    await page.route('**/*', async function (route) {
        const entry = lookup(route.request().url());
        if (entry == null) { await route.continue(); return; }
        if (typeof entry === 'string') {
            await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: entry });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: entry.contentType || 'text/html; charset=utf-8',
            body: entry.body
        });
    });
}
