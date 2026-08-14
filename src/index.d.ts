/**
 * Type definitions for @zakkster/lite-scroll-rig-pro
 */

/** A renderer driven by the engine each frame. */
export interface ScrollRenderer {
    render(currentY: number): void;
    resize?(): void;
}

export interface VirtualScrollOptions {
    maxScroll?: number;
    multiplier?: number;
    touchMultiplier?: number;
    /** Gesture factory (DI). Defaults to @zakkster/lite-gesture GestureTracker. */
    createTracker?: (element: unknown, handlers: { onPanMove?: (e: { frameDy: number }) => void }) => { destroy(): void };
    doc?: Document;
}

/** Normalizes wheel/trackpad/touch into a single clamped Y target. */
export class VirtualScroll {
    constructor(target: HTMLElement | Window, options?: VirtualScrollOptions);
    targetY: number;
    maxScroll: number;
    multiplier: number;
    touchMultiplier: number;
    isActive: boolean;
    setMaxScroll(max: number): void;
    destroy(): void;
}

export interface ScrollEngineOptions extends VirtualScrollOptions {
    /** lite-spring preset name (e.g. "gentle", "snappy", "stiff"). */
    preset?: string;
    /** dt clamp in seconds. Default 0.05. */
    maxDeltaTime?: number;
    /** Override the scroll ceiling calculation. */
    getMaxScroll?: () => number;
    /** Force reduced motion on/off; otherwise derived from prefers-reduced-motion. */
    reducedMotion?: boolean;
    /**
     * Bind window keydown scrolling (arrows / page keys / space / home / end).
     * Default true. Interactive-element focus is always suppressed; setting this
     * false detaches only the keydown listener, native scroll reconciliation
     * stays on. The native scrollbar is never synchronized (transform-only rig).
     */
    keyboard?: boolean;
    input?: unknown;
    spring?: unknown;
    win?: Window;
    raf?: (cb: (t: number) => void) => number;
    cancelRaf?: (handle: number) => void;
    matchMedia?: (query: string) => { matches: boolean };
}

/** Spring-smoothed scroll orchestrator + frame loop. */
export class ScrollEngine {
    constructor(target: HTMLElement | Window, options?: ScrollEngineOptions);
    currentY: number;
    isActive: boolean;
    input: VirtualScroll;
    addRenderer(renderer: ScrollRenderer): this;
    resize(): void;
    start(): void;
    destroy(): void;
}

export interface DOMScrollerOptions {
    binder?: unknown;
    win?: Window;
    observe?: boolean;
    ResizeObserverCtor?: typeof ResizeObserver;
}

/** Keyframe pool with an eval(rowIdx, t) hot path (e.g. @zakkster/lite-keyframe). */
export interface KeyframeEvaluator {
    eval(rowIdx: number, t: number): number;
}

/** Maps scroll progress to keyframed matrix3d transforms and batches them. */
export class DOMScroller implements ScrollRenderer {
    constructor(elements: HTMLElement[], pool: KeyframeEvaluator, options?: DOMScrollerOptions);
    render(currentY: number): void;
    resize(): void;
    destroy(): void;
}

export interface MetricsCacheOptions {
    observe?: boolean;
    ResizeObserverCtor?: typeof ResizeObserver;
    onResize?: () => void;
}

/** Pre-measured absolute Y-bounds; the render loop reads `bounds` only. */
export class MetricsCache {
    constructor(elements: Array<{ getBoundingClientRect(): DOMRect }>, win?: Window, options?: MetricsCacheOptions);
    bounds: Float32Array;
    count: number;
    measure(): void;
    destroy(): void;
}

/** Writes a matrix3d (16 floats, column-major) into outBuf at offset. */
export function composeMatrix2D(
    outBuf: Float32Array, offset: number,
    tx: number, ty: number, tz: number,
    sx: number, sy: number, rz: number
): void;

/** Zero-alloc: writes [enterY, exitY] into outBuf at offset. */
export function writeIntersectionBounds(
    outBuf: Float32Array, offset: number,
    absoluteTop: number, height: number, viewportHeight: number,
    offsetStart?: number, offsetEnd?: number
): void;

/** Allocating convenience: returns [enterY, exitY]. Not for hot loops. */
export function calculateIntersectionBounds(
    absoluteTop: number, height: number, viewportHeight: number,
    offsetStart?: number, offsetEnd?: number
): Float32Array;

/** Clamped [0, 1] progress across [startY, endY]. */
export function computeProgress(currentY: number, startY: number, endY: number): number;

/** Symmetric parallax offset: 0 -> +intensity, 0.5 -> 0, 1 -> -intensity. */
export function computeParallaxOffset(progress: number, intensity: number): number;

/** Package version, string-synced to package.json. */
export const VERSION: string;
