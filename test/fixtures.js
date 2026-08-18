/**
 * fixtures.js
 *
 * Shared headless fakes for the lite-scroll-rig-pro test suite. These extend
 * the ad-hoc fakes the individual test files grew so the DI style stays
 * consistent and nothing regresses.
 *
 * Run: imported by node:test files; not shipped.
 */

/**
 * A fake element. Carries the layout-space offset* surface the default
 * measurement path reads (offsetTop, offsetHeight, a chainable offsetParent),
 * PLUS getBoundingClientRect for the legacy 'rect' control path.
 *
 * @param {object} [opts]
 * @param {number} [opts.offsetTop=0]
 * @param {number} [opts.offsetHeight] - left undefined so the fail-closed skip
 *                 can be exercised by omitting it
 * @param {object} [opts.offsetParent=null] - another fakeEl or null
 * @param {object} [opts.rect] - explicit getBoundingClientRect result; defaults
 *                 to { top: offsetTop, height: offsetHeight } (untransformed)
 */
export function fakeEl(opts = {}) {
    const rect = opts.rect || { top: opts.offsetTop || 0, height: opts.offsetHeight || 0 };
    return {
        offsetTop: opts.offsetTop || 0,
        offsetHeight: opts.offsetHeight,
        offsetParent: opts.offsetParent || null,
        getBoundingClientRect: () => rect
    };
}

export function fakeWin(scrollY, innerHeight) {
    return { scrollY, innerHeight };
}

/**
 * matchMedia fake. Returns a factory; the factory returns one shared MQL object
 * with a live .matches flag, change listeners, and an emit(matches) that flips
 * the flag and dispatches. listenerCount() lets a test assert 0 after destroy.
 */
export function makeMatchMedia(initialMatches = false) {
    const listeners = new Set();
    const mql = {
        matches: !!initialMatches,
        addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
        removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn); },
        emit(matches) {
            mql.matches = !!matches;
            for (const fn of listeners) fn({ matches: mql.matches });
        },
        listenerCount() { return listeners.size; }
    };
    const fn = () => mql;
    fn.mql = mql;
    return fn;
}

/**
 * A fake ResizeObserver with liveCount() = observed-minus-disconnected. One
 * instance tracks its own live count; disconnect() zeroes it.
 */
export class FakeRO {
    constructor(cb) {
        this.cb = cb;
        this.observed = [];
        this.disconnected = false;
        this._live = 0;
    }
    observe(el) { this.observed.push(el); this._live++; }
    unobserve() { if (this._live > 0) this._live--; }
    disconnect() { this.disconnected = true; this._live = 0; }
    trigger() { this.cb([]); }
    liveCount() { return this._live; }
}

/**
 * A ResizeObserver constructor that records every instance it creates, so a
 * leak test can assert the total live count across a churn loop returns to 0.
 */
export function makeROFactory() {
    const instances = [];
    function Ctor(cb) {
        const ro = new FakeRO(cb);
        instances.push(ro);
        return ro;
    }
    Ctor.instances = instances;
    Ctor.liveTotal = () => {
        let n = 0;
        for (let i = 0; i < instances.length; i++) n += instances[i].liveCount();
        return n;
    };
    Ctor.reset = () => { instances.length = 0; };
    return Ctor;
}

/**
 * A ResizeObserver constructor for RETENTION churn: it tracks a shared live
 * count via a counter only, WITHOUT retaining the instances it creates. A
 * factory that held every instance would itself be the heap growth a retention
 * probe is trying to catch. liveTotal() reads the counter; observe increments,
 * disconnect zeroes the instance's contribution.
 */
export function makeCountingRO() {
    const state = { live: 0 };
    class RO {
        constructor(cb) { this._cb = cb; this._n = 0; }
        observe() { this._n++; state.live++; }
        unobserve() { if (this._n > 0) { this._n--; state.live--; } }
        disconnect() { state.live -= this._n; this._n = 0; }
        trigger() { this._cb([]); }
    }
    function Ctor(cb) { return new RO(cb); }
    Ctor.liveTotal = () => state.live;
    return Ctor;
}

// --- input / spring / raf / renderer / binder / pool fakes (shape-compatible
//     with the ad-hoc fakes already used across the suite) --------------------

export function fakeInput(targetY = 0, maxScroll = Infinity) {
    return {
        targetY,
        maxScroll,
        _lastNativeY: 0,
        maxSet: null,
        destroyed: false,
        setMaxScroll(m) { this.maxSet = m; this.maxScroll = m; },
        // Clamped absolute setter, mirrors VirtualScroll.setTargetY: rejects any
        // non-number and NaN; +/-Infinity passes and clamps.
        setTargetY(y) {
            if (typeof y !== 'number' || y !== y) return;
            let v = y;
            if (v < 0) v = 0;
            else if (v > this.maxScroll) v = this.maxScroll;
            this.targetY = v;
        },
        destroy() { this.destroyed = true; }
    };
}

/**
 * A fake window/target with an addEventListener surface for the native-scroll
 * and keydown paths. Tracks listener counts per type (so a test can assert 0
 * after destroy), and emits synthetic events:
 *   emitScroll(y?)      - optionally moves scrollY, then dispatches 'scroll'
 *   emitKey(key, opts)  - dispatches a 'keydown' with { key, shiftKey, target,
 *                         cancelable }; returns the event so a test can read
 *                         its _prevented flag.
 *
 * @param {object} [init] - { scrollY, innerHeight }
 */
export function fakeTarget(init = {}) {
    const listeners = new Map(); // type -> Set<fn>
    const t = {
        scrollY: init.scrollY || 0,
        innerHeight: init.innerHeight != null ? init.innerHeight : 800,
        addEventListener(type, fn) {
            let s = listeners.get(type);
            if (!s) { s = new Set(); listeners.set(type, s); }
            s.add(fn);
        },
        removeEventListener(type, fn) {
            const s = listeners.get(type);
            if (s) s.delete(fn);
        },
        listenerCount(type) {
            if (type == null) {
                let n = 0;
                for (const s of listeners.values()) n += s.size;
                return n;
            }
            const s = listeners.get(type);
            return s ? s.size : 0;
        },
        emitScroll(y) {
            if (y != null) t.scrollY = y;
            const s = listeners.get('scroll');
            if (s) for (const fn of s) fn({ type: 'scroll' });
        },
        emitKey(key, opts = {}) {
            // A real window keydown always carries a target; default to a
            // non-interactive stand-in. Pass target:null explicitly to exercise
            // the fail-closed suppression.
            const e = {
                type: 'keydown',
                key,
                shiftKey: !!opts.shiftKey,
                target: 'target' in opts ? opts.target : { tagName: 'DIV' },
                cancelable: opts.cancelable !== false,
                _prevented: false,
                preventDefault() { this._prevented = true; }
            };
            const s = listeners.get('keydown');
            if (s) for (const fn of s) fn(e);
            return e;
        }
    };
    return t;
}

// Fake spring: update() returns a sentinel distinct from target, proving the
// engine forwards the spring's output (not the raw target) to renderers. The
// second arg seeds a settable `velocity` field (SR-05 park/wake): the engine's
// settle test reads spring.velocity, so a test can drive it to rest (0), keep it
// moving (>= SETTLE_VEL), or feed a non-finite value to exercise fail-closed.
export function fakeSpring(ret = 999, velocity = 0) {
    return {
        target: 0, velocity, _ret: ret, updateCalls: 0, lastDt: -1, snapped: null,
        snap(v) { this.snapped = v; this.target = v; this.velocity = 0; },
        update(dt) { this.updateCalls++; this.lastDt = dt; return this._ret; }
    };
}

export function fakeRaf() {
    const s = { handle: 0, lastCb: null, cancelledWith: null };
    return {
        raf: (cb) => { s.lastCb = cb; return ++s.handle; },
        cancel: (h) => { s.cancelledWith = h; },
        s
    };
}

export function makeRenderer() {
    return {
        rendered: [], resizes: 0, destroyed: false,
        render(y) { this.rendered.push(y); },
        resize() { this.resizes++; },
        destroy() { this.destroyed = true; }
    };
}

export function fakeBinder() {
    return {
        invalidateCount: 0, updateCalls: 0, lastMatrices: null, lastCount: 0, destroyed: false,
        invalidate() { this.invalidateCount++; },
        updateDOMTransforms(els, m, c) { this.lastMatrices = m.slice(); this.lastCount = c; this.updateCalls++; },
        destroy() { this.destroyed = true; }
    };
}

// A zero-allocation binder for hot-path ceilings: it must not slice() the
// buffer (that would allocate every frame and pollute the alloc gate).
export function noopBinder() {
    return {
        invalidate() {},
        updateDOMTransforms() {},
        destroy() {}
    };
}

// Deterministic pool: row R at time t evaluates to R + t. Allocation-free.
export const fakePool = { eval(row, t) { return row + t; } };
