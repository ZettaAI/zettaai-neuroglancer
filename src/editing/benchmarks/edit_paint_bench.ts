/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * In-app edit-session paint benchmark harness (driven by Playwright).
 *
 * Exposed as `window.__editPaintBench(opts?)`. The dev-server app is loaded with
 * an ngState that carries an `editSession` block, so the host AUTO-OPENS the
 * session + restores the brush/mask preset on load — this harness does NOT open
 * a session; it waits for the active one, then for each {case × brush size}
 * drives a real stroke via SYNTHETIC pointer events on the slice canvas
 * (exercising the full stack: scheduler → pointer→voxel → pyodide compute →
 * commit → GPU upload) and snapshots `__paintProfiler`.
 *
 * Cases: masked brush (the state's threshold + morphology preset), unmasked
 * brush, eraser.
 *
 * ⚠ Benchmark harness, NOT a unit test. The end-to-end run needs a
 * cross-origin-isolated browser with WebGL2 + pyodide (the dev-server build), so
 * it cannot run under vitest/node. A few integration details (canvas discovery,
 * pointer dispatch, settle waits) are best-effort — see `// TUNE:` markers. The
 * reusable, verified pieces are `paintProfiler.snapshot()/resetWindow()`.
 */

import {
  summarizePatchedVoxels,
  type PatchReadbackSummary,
} from "#src/editing/benchmarks/patch_readback.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";

/** One {case × size} measurement. */
export interface EditPaintBenchResult {
  readonly case: "masked-brush" | "unmasked-brush" | "eraser";
  /** Brush diameter (2r+1). */
  readonly size: number;
  readonly radius: number;
  readonly ok: boolean;
  readonly error?: string;
  /**
   * The full sectioned `__paintProfiler` summary for this stroke (params ·
   * BLOCKS-UI · ①..⑥ phase tables · counts), exactly as the console prints it,
   * minus the interactive copy hint. This is the primary output.
   */
  readonly summary: string;
  /** Selected profiler bucket totals (ms) — for the JSON artifact. */
  readonly timings: Record<string, number>;
  /** Selected profiler counters — for the JSON artifact. */
  readonly counters: Record<string, number>;
}

export interface EditPaintBenchOptions {
  /** Brush diameters to sweep. Default: 5, 51, 251, 501, 751, 1025. */
  readonly sizes?: readonly number[];
  /** Which cases to run. Default: all three. */
  readonly cases?: ReadonlyArray<EditPaintBenchResult["case"]>;
  /** rAF frames to wait after a stroke so the GPU upload buckets land. */
  readonly renderFramesAfterStroke?: number;
  /** Max ms to wait for a stroke's worker round-trip + commit to settle. */
  readonly settleTimeoutMs?: number;
  /** Max ms to wait for the host to auto-open the session from ngState. */
  readonly sessionTimeoutMs?: number;
  /** ms to let pyodide warm up after the session opens (masked path). */
  readonly warmupMs?: number;
  /** Pointermove samples in the swept drag (default 40). */
  readonly strokePoints?: number;
  /** ms between samples — pace ≈ worker round-trip so each becomes a segment (default 80). */
  readonly strokeStepMs?: number;
}

const DEFAULT_SIZES = [5, 51, 251, 501, 751, 1025] as const;

// Profiler buckets/counters surfaced per result (others dropped to keep the
// payload small across `page.evaluate`).
const TIMING_KEYS = [
  "0.stroke(total)",
  "4.handleInput(total)",
  "P.pipeline(worker)",
  "P.w.maskBuild(py)",
  "P.w.closing(py)",
  "P.w.components(py)",
  "P.slabCopy(cpu)",
  "P.write(cpu)",
  "2b.morphology(worker)",
  "2a.maskBuild(cpu)",
  "apply.total(cpu)",
  "5.mirror.fuse(cpu)",
  "6.gpu.upload(value)",
  "6.gpu.upload(mask)",
  "mt.frameDraw",
];
const COUNTER_KEYS = [
  "voxels.footprintBbox",
  "voxels.painted",
  "overlay.paint.apply.chunks",
  "gpu.uploadBytes",
  "morphology.heapPressure",
  "morphology.workerReinit",
];

type Any = any;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickTimings(
  buckets: Record<string, { totalMs: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of TIMING_KEYS) {
    if (buckets[k] !== undefined) {
      out[k] = Math.round(buckets[k].totalMs * 10) / 10;
    }
  }
  return out;
}
function pickCounters(
  counters: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of COUNTER_KEYS) {
    if (counters[k] !== undefined) out[k] = counters[k];
  }
  return out;
}

/**
 * Element to dispatch pointer events on. The `PointerEventBridge` registers its
 * handlers on the slice PANEL element (not the shared GL canvas), so we resolve
 * the topmost element at the largest canvas's centre via `elementFromPoint` —
 * that is the interactive panel element, and bubbling carries the event to the
 * bridge. TUNE: if strokes don't register, log this element's class chain.
 */
function findDispatchTarget(): HTMLElement {
  const canvases = Array.from(
    document.querySelectorAll("canvas"),
  ) as HTMLCanvasElement[];
  let best: HTMLCanvasElement | undefined;
  let bestArea = 0;
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = c;
    }
  }
  if (best === undefined) throw new Error("editPaintBench: no canvas found");
  const r = best.getBoundingClientRect();
  const el = document.elementFromPoint(
    r.left + r.width / 2,
    r.top + r.height / 2,
  ) as HTMLElement | null;
  return el ?? best;
}

/**
 * Fire a synthetic stroke that mirrors a REAL drag: pointerdown → many
 * pointermoves SWEEPING across most of the panel (a sine zigzag, so it covers a
 * 2D band of FRESH chunks, not one stationary spot) → pointerup. Moves are paced
 * (`stepMs`, ≈ the worker round-trip) so each delivered move becomes its own
 * stroke segment — reproducing sustained load (pyodide heap growth/GC over many
 * segments) AND the per-segment apply/commit cost (`writeRegion` over fresh
 * territory). A tiny stationary wiggle (the old version) under-measured both.
 */
async function dispatchStroke(
  el: HTMLElement,
  points: number,
  stepMs: number,
): Promise<void> {
  const rect = el.getBoundingClientRect();
  const x0 = rect.left + rect.width * 0.12;
  const x1 = rect.left + rect.width * 0.88;
  const yc = rect.top + rect.height * 0.5;
  const amp = rect.height * 0.3;
  const n = Math.max(2, Math.floor(points));
  const at = (i: number): [number, number] => {
    const t = i / (n - 1);
    return [x0 + (x1 - x0) * t, yc + Math.sin(t * Math.PI * 3) * amp];
  };
  const common = {
    pointerId: 1,
    isPrimary: true,
    bubbles: true,
    cancelable: true,
  } as const;
  const [dx, dy] = at(0);
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      ...common,
      clientX: dx,
      clientY: dy,
      button: 0,
      buttons: 1,
    }),
  );
  for (let i = 1; i < n; i++) {
    const [x, y] = at(i);
    el.dispatchEvent(
      new PointerEvent("pointermove", {
        ...common,
        clientX: x,
        clientY: y,
        button: -1,
        buttons: 1,
      }),
    );
    await delay(stepMs);
  }
  const [lx, ly] = at(n - 1);
  el.dispatchEvent(
    new PointerEvent("pointerup", {
      ...common,
      clientX: lx,
      clientY: ly,
      button: 0,
      buttons: 0,
    }),
  );
}

const CLOSED_LOOP_STEPS = 48;

/** A full circle starting and ending at its rightmost point (TM-268). */
function dispatchClosedLoop(
  el: HTMLElement,
  centerX: number,
  centerY: number,
  radiusPx: number,
): void {
  const pointerEvent = (type: string, step: number, buttons: number) => {
    const angle = (2 * Math.PI * step) / CLOSED_LOOP_STEPS;
    return new PointerEvent(type, {
      pointerId: 1,
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      clientX: centerX + radiusPx * Math.cos(angle),
      clientY: centerY + radiusPx * Math.sin(angle),
      button: type === "pointermove" ? -1 : 0,
      buttons,
    });
  };
  el.dispatchEvent(pointerEvent("pointerdown", 0, 1));
  for (let step = 1; step <= CLOSED_LOOP_STEPS; step++) {
    el.dispatchEvent(pointerEvent("pointermove", step, 1));
  }
  el.dispatchEvent(pointerEvent("pointerup", CLOSED_LOOP_STEPS, 0));
}

/** A single brush stamp at `(x, y)`: down + one tiny move + up → one segment. */
function dispatchStamp(el: HTMLElement, x: number, y: number): void {
  const c = {
    pointerId: 1,
    isPrimary: true,
    bubbles: true,
    cancelable: true,
  } as const;
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      ...c,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    }),
  );
  el.dispatchEvent(
    new PointerEvent("pointermove", {
      ...c,
      clientX: x + 2,
      clientY: y,
      button: -1,
      buttons: 1,
    }),
  );
  el.dispatchEvent(
    new PointerEvent("pointerup", {
      ...c,
      clientX: x + 2,
      clientY: y,
      button: 0,
      buttons: 0,
    }),
  );
}

/**
 * Warm the data path BEFORE measuring: a few discrete max-radius stamps spread
 * across the sweep band, each fully settled, so the EM/target chunks they touch
 * become resident. Without this the FIRST measured segment pays a cold
 * `gs://` `chunkRead` (seconds), which — being far longer than the move pacing —
 * makes `latestWins` drop every other move and collapse the stroke to ONE
 * segment (no per-segment numbers). Real painting has these chunks warm.
 * Profiler is reset after, so warmup doesn't pollute the measured window.
 */
export async function warmupEditPaintBench(
  opts: EditPaintBenchOptions & {
    warmupStamps?: number;
    warmupSettleMs?: number;
  } = {},
): Promise<{ stamps: number; ms: number }> {
  const t0 = performance.now();
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  await waitForActiveSession(host, opts.sessionTimeoutMs ?? 120000);
  const ps = host.painting.state;
  const base = ps.getState();
  if (presetMask === undefined) presetMask = base.mask;
  presetRadius = base.radius ?? 512;
  ps.patchState({ radius: 512, mask: presetMask });
  host.selectTool("painting.brush");
  await delay(opts.warmupMs ?? 1500); // let pyodide boot too

  const el = findDispatchTarget();
  const rect = el.getBoundingClientRect();
  const n = Math.max(2, opts.warmupStamps ?? 8);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = rect.left + rect.width * (0.12 + 0.76 * t);
    const y = rect.top + rect.height * (0.3 + 0.4 * (i % 2));
    paintProfiler.enabled = true;
    paintProfiler.resetWindow();
    dispatchStamp(el, x, y);
    await waitForSettle(opts.warmupSettleMs ?? 60000);
    paintProfiler.enabled = false;
    paintProfiler.resetWindow();
  }
  return { stamps: n, ms: Math.round(performance.now() - t0) };
}

/** Wait until the host has auto-opened the session from the ngState block. */
async function waitForActiveSession(
  host: Any,
  timeoutMs: number,
): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (
      host.activeSession?.value !== undefined &&
      host.painting !== undefined
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    "editPaintBench: no active session — the ngState must carry an " +
      "`editSession` block so the host auto-opens it.",
  );
}

/**
 * Heuristic settle: wait until the profiler's stroke/apply totals stop growing
 * across consecutive samples (gate + worker round-trip + commit drained), or the
 * timeout elapses. TUNE if strokes need longer.
 */
async function waitForSettle(timeoutMs: number): Promise<void> {
  const start = performance.now();
  let prev = -1;
  let stable = 0;
  while (performance.now() - start < timeoutMs) {
    await delay(50);
    const s = paintProfiler.snapshot();
    // `0.stroke(total)` is absent on the newer `worker-mask` path; the
    // `handleInput` span is the robust progress signal.
    const cur =
      (s.buckets["4.handleInput(total)"]?.totalMs ??
        s.buckets["0.stroke(total)"]?.totalMs ??
        0) + (s.buckets["apply.total(cpu)"]?.totalMs ?? 0);
    if (cur > 0 && cur === prev) {
      if (++stable >= 3) return;
    } else {
      stable = 0;
    }
    prev = cur;
  }
}

/** Module-level state shared across step calls (persists until page navigation). */
let presetMask: unknown = undefined;
let presetRadius = 512;

export interface EditPaintBenchDiag {
  readonly sessionActive: boolean;
  readonly crossOriginIsolated: boolean;
  /** Painting state read after warmup. */
  readonly hasMaskPreset: boolean;
  readonly targetLayerId: unknown;
  readonly maskImageLayerId: unknown;
  readonly canvas: { w: number; h: number } | null;
  /** Tag of the element the strokes will be dispatched on. */
  readonly dispatchTarget: string;
  readonly error?: string;
}

/**
 * Step 1: wait for the auto-opened session, warm up pyodide, capture the brush +
 * mask preset, and return diagnostics. Called ONCE before the sweep so a single
 * short `page.evaluate` surfaces whether the session/mask/canvas are usable
 * (rather than hiding it inside a long opaque sweep).
 */
export async function prepareEditPaintBench(
  opts: EditPaintBenchOptions = {},
): Promise<EditPaintBenchDiag> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  const diag: {
    -readonly [K in keyof EditPaintBenchDiag]: EditPaintBenchDiag[K];
  } = {
    sessionActive: false,
    crossOriginIsolated:
      (globalThis as unknown as { crossOriginIsolated?: boolean })
        .crossOriginIsolated === true,
    hasMaskPreset: false,
    targetLayerId: undefined,
    maskImageLayerId: undefined,
    canvas: null,
    dispatchTarget: "none",
  };
  try {
    if (host === undefined)
      throw new Error("window.viewer.editSessionHost missing");
    await waitForActiveSession(host, opts.sessionTimeoutMs ?? 120000);
    diag.sessionActive = true;
    await delay(opts.warmupMs ?? 4000); // pyodide warmup
    const base = host.painting.state.getState();
    presetMask = base.mask;
    presetRadius = base.radius ?? 512;
    diag.hasMaskPreset = base.mask !== undefined && base.mask !== null;
    diag.targetLayerId = base.targetLayerId;
    diag.maskImageLayerId = base.mask?.imageLayerId;
    const el = findDispatchTarget();
    const r = el.getBoundingClientRect();
    diag.canvas = { w: Math.round(r.width), h: Math.round(r.height) };
    diag.dispatchTarget =
      (el.tagName || "?") +
      (el.className ? "." + String(el.className).split(" ")[0] : "");
  } catch (e) {
    diag.error = e instanceof Error ? e.message : String(e);
  }
  return diag;
}

/**
 * Step 2: run ONE {case × size} stroke and return its row + a tiny diagnostic
 * (`maskedComputeRan`, `strokeFired`). Each call is its own short
 * `page.evaluate`, so a mid-sweep navigation only loses the current cell and the
 * spec can report partial results + pinpoint the failing cell.
 */
export async function stepEditPaintBench(input: {
  case: EditPaintBenchResult["case"];
  size: number;
  settleTimeoutMs?: number;
  renderFramesAfterStroke?: number;
  /** Pointermove samples in the swept drag (default 40). */
  strokePoints?: number;
  /** ms between samples — pace ≈ worker round-trip so each becomes a segment (default 80). */
  strokeStepMs?: number;
}): Promise<
  EditPaintBenchResult & { maskedComputeRan: boolean; strokeFired: boolean }
> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  const radius = (input.size - 1) / 2;
  const row: {
    -readonly [K in keyof EditPaintBenchResult]: EditPaintBenchResult[K];
  } & { maskedComputeRan: boolean; strokeFired: boolean } = {
    case: input.case,
    size: input.size,
    radius,
    ok: false,
    summary: "",
    timings: {},
    counters: {},
    maskedComputeRan: false,
    strokeFired: false,
  };
  try {
    const ps = host.painting.state;
    ps.patchState({
      radius,
      mask: input.case === "masked-brush" ? presetMask : undefined,
    });
    host.selectTool(
      input.case === "eraser" ? "painting.erase" : "painting.brush",
    );
    await nextFrame();

    paintProfiler.enabled = true;
    paintProfiler.resetWindow();

    await dispatchStroke(
      findDispatchTarget(),
      input.strokePoints ?? 40,
      input.strokeStepMs ?? 80,
    );
    await waitForSettle(input.settleTimeoutMs ?? 60000);
    for (let i = 0; i < (input.renderFramesAfterStroke ?? 4); i++)
      await nextFrame();

    // The full sectioned block (same format as the console summary) — captured
    // BEFORE resetWindow() clears the accumulation.
    row.summary = paintProfiler.renderSummary();
    const snap = paintProfiler.snapshot();
    row.timings = pickTimings(snap.buckets);
    row.counters = pickCounters(snap.counters);
    row.strokeFired =
      snap.buckets["4.handleInput(total)"] !== undefined ||
      snap.buckets["0.stroke(total)"] !== undefined;
    row.maskedComputeRan = Object.keys(snap.buckets).some(
      (k) => k.startsWith("P.") || k.startsWith("2b."),
    );
    row.ok = row.summary.length > 0;
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  } finally {
    paintProfiler.enabled = false;
    paintProfiler.resetWindow();
  }
  return row;
}

/** Restore the original brush preset so the app is left as loaded. */
export function finishEditPaintBench(): void {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  try {
    viewer?.editSessionHost?.painting?.state?.patchState?.({
      radius: presetRadius,
      mask: presetMask,
    });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Read-back (TM-331, phase 2) — turn the painted overlay into an assertable
// summary so the e2e spec can check CORRECTNESS (not just perf): what voxels
// landed, their values, a bbox, and a stable signature for regression.
// ---------------------------------------------------------------------------

export interface EditPaintReadback extends PatchReadbackSummary {
  /** The target layer the patches were read from. */
  readonly targetLayerId: unknown;
  /** Set when the target layer's patch store could not be resolved. */
  readonly error?: string;
}

/** Resolve the active target layer's `LocalPatchStore` (best-effort). */
function targetPatchStore(
  host: Any,
  explicitLayerId?: string,
): { layerId: unknown; store: Any } {
  const layerId =
    explicitLayerId ?? host?.painting?.state?.getState?.()?.targetLayerId;
  const store = host?.perLayer?.get?.(layerId)?.patchStore;
  return { layerId, store };
}

/**
 * Read the painted voxels currently in the target layer's overlay patch store
 * and summarize them (count · bbox · distinct values · stable signature). This
 * reflects exactly what a save would persist for the target.
 */
export function readbackEditPaintTarget(
  opts: {
    maxVoxels?: number;
    sampleSize?: number;
    originOffset?: readonly [number, number, number];
    /** Read this layer's patches; default the painting target (needs a session). */
    layerId?: string;
    /** Also count the patched voxels holding this value (`valueCount`). */
    countValue?: string;
  } = {},
): EditPaintReadback {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  const { layerId, store } = targetPatchStore(host, opts.layerId);
  if (store?.source?.chunks === undefined) {
    return {
      targetLayerId: layerId,
      error: "no patch store for the active target layer",
      paintedVoxels: 0,
      chunkCount: 0,
      bbox: null,
      signature: "00000000",
      distinctValues: [],
      sample: [],
      truncated: false,
      valueCount: 0,
    };
  }
  const summary = summarizePatchedVoxels(store.source.chunks.entries(), opts);
  return { targetLayerId: layerId, ...summary };
}

/**
 * Drop every patch in the target layer's overlay so the next stamp's read-back
 * is isolated. Test hygiene only (the harness inspects, never saves), so the
 * session dirty/baseline bookkeeping is intentionally left untouched.
 */
export function clearEditPaintTargetPatches(): boolean {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  const { store } = targetPatchStore(host);
  if (store?.clearAll === undefined) return false;
  store.clearAll();
  return true;
}

export interface StampReadbackInput {
  /** The `fillClosedPaths` brush setting for this stamp (default false). */
  readonly fillClosedPaths?: boolean;
  /**
   * Draw a closed circle of this radius, in screen pixels, instead of a single
   * stamp, with its moves all arriving in one go, as in a fast drag.
   */
  readonly closedLoopRadiusPx?: number;
  /** Apply the loaded threshold/morphology mask preset (default false). */
  readonly masked?: boolean;
  /** Brush radius in voxels (default 8 — small, for a deterministic read-back). */
  readonly radius?: number;
  /** Erase instead of paint (default false). */
  readonly erase?: boolean;
  /** Fractional panel position of the stamp (default centre). */
  readonly fracX?: number;
  readonly fracY?: number;
  /**
   * Position of the stamp in target voxels from the panel centre, as in
   * `strokeVoxelPath`. Overrides `fracX` / `fracY`.
   */
  readonly centerVoxels?: readonly [number, number];
  /** Clear the target's existing patches first, so read-back is just this stamp. */
  readonly clearFirst?: boolean;
  /**
   * Discarded warm-up stamps before the measured one, to settle async brush-param
   * (radius/mask) propagation so the measure is deterministic. Default 2; only
   * applied when `clearFirst` (a fresh measure).
   */
  readonly prime?: number;
  readonly settleTimeoutMs?: number;
  readonly maxVoxels?: number;
  readonly sampleSize?: number;
  /**
   * Added to read-back coordinates to report ABSOLUTE global voxels (the patch
   * store is offset-relative). Pass the target layer's scale `voxelOffset` so the
   * bbox is comparable to the edit region.
   */
  readonly originOffset?: readonly [number, number, number];
}

/**
 * Wait until the target's painted-voxel count stops changing across consecutive
 * polls (the overlay write settles AFTER `handleInput`'s promise resolves, so a
 * profiler-based settle can race it), and return the final count. Gives up fast
 * when nothing is painting — a mis-registered stamp would otherwise spin the
 * whole timeout (that was the multi-minute hang). `zeroGiveupMs` bounds the
 * "still empty" wait (kept above pyodide's cold-boot so a masked stamp isn't
 * abandoned mid-boot).
 */
async function waitForPaintStable(
  timeoutMs: number,
  zeroGiveupMs = 5000,
): Promise<number> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  const start = performance.now();
  let prev = -1;
  let stable = 0;
  let zeroMs = 0;
  while (performance.now() - start < timeoutMs) {
    await delay(80);
    const { store } = targetPatchStore(host);
    const count =
      typeof store?.countPatchedVoxels === "function"
        ? store.countPatchedVoxels()
        : 0;
    if (count === 0) {
      zeroMs += 80;
      if (zeroMs >= zeroGiveupMs) return 0;
      stable = 0;
      prev = 0;
      continue;
    }
    zeroMs = 0;
    if (count === prev) {
      if (++stable >= 3) return count;
    } else {
      stable = 0;
    }
    prev = count;
  }
  return prev < 0 ? 0 : prev;
}

/**
 * Drive ONE deterministic stamp at a fixed panel position (not the sweeping
 * perf stroke) through the full real stack, then read back the painted result.
 * This is the correctness primitive: same inputs ⇒ same `signature`.
 */
export async function stampAndReadbackEditPaint(
  input: StampReadbackInput = {},
): Promise<EditPaintReadback & { strokeFired: boolean }> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  try {
    await waitForActiveSession(host, 120000);
    const ps = host.painting.state;
    if (presetMask === undefined) presetMask = ps.getState().mask;
    ps.patchState({
      radius: input.radius ?? 8,
      mask: input.masked ? presetMask : undefined,
      fillClosedPaths: input.fillClosedPaths ?? false,
    });
    host.selectTool(input.erase ? "painting.erase" : "painting.brush");
    await nextFrame();

    const el = findDispatchTarget();
    const rect = el.getBoundingClientRect();
    const [x, y] =
      input.centerVoxels !== undefined
        ? voxelToClient()(input.centerVoxels)
        : [
            rect.left + rect.width * (input.fracX ?? 0.5),
            rect.top + rect.height * (input.fracY ?? 0.5),
          ];
    // Bounded (was 60s) — a mis-registered stamp used to spin the full minute
    // per stamp; `waitForPaintStable` also gives up fast on zero paint.
    const settleMs = input.settleTimeoutMs ?? 15000;
    const doStamp = async (): Promise<number> => {
      if (input.closedLoopRadiusPx !== undefined) {
        dispatchClosedLoop(el, x, y, input.closedLoopRadiusPx);
      } else {
        dispatchStamp(el, x, y);
      }
      await waitForSettle(settleMs);
      // The overlay write lands after the apply promise; wait for the painted
      // count to settle so the read-back is deterministic (not a race).
      return waitForPaintStable(settleMs);
    };

    // Brush-param changes (radius/mask) propagate to the tool asynchronously, so
    // the FIRST stamp after a change can paint with the stale value (radius lag).
    // On a fresh measure, prime with discarded stamp(s) so the measured stamp
    // uses the settled params. Skipped when clearFirst=false (e.g. erase-after-
    // paint, which must keep the prior stamp).
    const clearFirst = input.clearFirst ?? true;
    if (clearFirst) {
      const primes = input.prime ?? 1;
      for (let i = 0; i < primes; i++) {
        clearEditPaintTargetPatches();
        const n = await doStamp();
        console.log(`[editPaintBench] prime ${i + 1}/${primes}: painted=${n}`);
      }
      clearEditPaintTargetPatches();
      await nextFrame();
    }

    paintProfiler.enabled = true;
    paintProfiler.resetWindow();
    const measured = await doStamp();
    console.log(`[editPaintBench] measure: painted=${measured}`);

    const readback = readbackEditPaintTarget({
      maxVoxels: input.maxVoxels,
      sampleSize: input.sampleSize,
      originOffset: input.originOffset,
    });
    // A real registration = something was painted, or (for a legitimately-empty
    // masked stamp) any profiler activity. The old `4.handleInput(total)` bucket
    // only fires on pointer-MOVE, so a single down-stamp read false — hence this.
    const strokeFired =
      readback.paintedVoxels > 0 ||
      Object.keys(paintProfiler.snapshot().buckets).length > 0;
    return { ...readback, strokeFired };
  } catch (e) {
    return {
      targetLayerId: undefined,
      error: e instanceof Error ? e.message : String(e),
      paintedVoxels: 0,
      chunkCount: 0,
      bbox: null,
      signature: "00000000",
      distinctValues: [],
      sample: [],
      truncated: false,
      valueCount: 0,
      strokeFired: false,
    };
  } finally {
    paintProfiler.enabled = false;
    paintProfiler.resetWindow();
  }
}

// ---------------------------------------------------------------------------
// Large-chunk benchmark (TM-373) — strokes placed in VOXELS, not panel
// fractions, so the same path lands on the same chunks whatever the chunk size,
// plus undo depth and frame pacing.
// ---------------------------------------------------------------------------

/** Profiler buckets whose growth means a stroke (or undo) is still landing. */
const LARGE_CHUNK_SETTLE_KEYS = [
  "4.handleInput(total)",
  "apply.total(cpu)",
  "5.mirror.read(io)",
  "5.mirror.fuse(cpu)",
  "edit.record(cpu)",
  "6.gpu.upload(value)",
  "6.gpu.upload(mask)",
];

/** A window with no profiler activity for this long did no paint work. */
const NOTHING_LANDED_GIVEUP_MS = 5000;

const LARGE_CHUNK_TIMING_KEYS = [
  "4.handleInput(total)",
  "apply.total(cpu)",
  "overlay.paint.apply.writeRegion",
  "overlay.paint.materialize.fetchBaseline",
  "overlay.paint.materialize.clones",
  "5.mirror.read(io)",
  "5.mirror.fuse(cpu)",
  "edit.record(cpu)",
  "6.gpu.upload(value)",
  "6.gpu.upload(mask)",
  "mt.frameDraw",
  "mt.longtask(>50ms)",
];

const LARGE_CHUNK_COUNTER_KEYS = [
  "overlay.paint.apply.chunks",
  "mirror.syncs",
  "mirror.syncs.full",
  "mirror.syncs.bounded",
  "previewBaseline.reads",
  "previewBaseline.evictions",
  "gpu.uploadBytes",
  // Upload kinds (TM-373, PR 6): a full upload, a new texture (empty +
  // paintedBounds) and a sub-box upload.
  "gpu.upload.value.full",
  "gpu.upload.mask.full",
  "gpu.upload.value.create",
  "gpu.upload.mask.create",
  "gpu.upload.value.sub",
  "gpu.upload.mask.sub",
];

/** Time between animation frames while a stroke lands. */
export interface FramePacing {
  readonly frames: number;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

/** One profiled window (a stroke, or an undo) of the large-chunk benchmark. */
export interface LargeChunkWindow {
  readonly ok: boolean;
  readonly error?: string;
  /** Wall time from the first pointer event (or the undo call) to settle. */
  readonly wallMs: number;
  readonly frames: FramePacing;
  /** Profiler totals (ms) and call counts for the `LARGE_CHUNK_*` keys. */
  readonly timings: Record<
    string,
    { totalMs: number; calls: number; maxMs: number }
  >;
  readonly counters: Record<string, number>;
  /** The full sectioned profiler block for the window. */
  readonly summary: string;
  /** `performance.memory.usedJSHeapSize` after the window, in MB (Chromium). */
  readonly jsHeapMb?: number;
}

export interface VoxelStrokeInput {
  /**
   * In-plane stroke points in target voxels, relative to the panel centre (the
   * ngState `position`). Consecutive points become separate pointer moves.
   */
  readonly path: ReadonlyArray<readonly [number, number]>;
  /** Brush radius in voxels. */
  readonly radius: number;
  /**
   * Apply the loaded mask preset. A masked stroke records an after-image
   * (`image` redo); an unmasked one replays instead (TM-319). Default false.
   */
  readonly masked?: boolean;
  /** ms between pointer moves (default 80 — about one worker round-trip). */
  readonly stepMs?: number;
  readonly settleTimeoutMs?: number;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function heapMegabytes(): number | undefined {
  const memory = (
    performance as unknown as { memory?: { usedJSHeapSize: number } }
  ).memory;
  return memory === undefined
    ? undefined
    : roundTenth(memory.usedJSHeapSize / (1024 * 1024));
}

/** Sample frame-to-frame intervals until `stop()` is called. */
function startFramePacing(): { stop(): FramePacing } {
  const intervals: number[] = [];
  let running = true;
  let previous = performance.now();
  const onFrame = (now: number) => {
    if (!running) return;
    intervals.push(now - previous);
    previous = now;
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  return {
    stop(): FramePacing {
      running = false;
      if (intervals.length === 0) {
        return { frames: 0, meanMs: 0, p95Ms: 0, maxMs: 0 };
      }
      const sorted = [...intervals].sort((a, b) => a - b);
      const total = sorted.reduce((sum, interval) => sum + interval, 0);
      const p95Index = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.95),
      );
      return {
        frames: sorted.length,
        meanMs: roundTenth(total / sorted.length),
        p95Ms: roundTenth(sorted[p95Index]),
        maxMs: roundTenth(sorted[sorted.length - 1]),
      };
    },
  };
}

/**
 * Wait until none of `LARGE_CHUNK_SETTLE_KEYS` has grown for `quietMs`: input,
 * apply, the mirror's async passes and the end-of-stroke record all count, so a
 * mirror pass still decoding a 4096² baseline keeps the window open.
 */
async function waitForLargeChunkSettle(
  timeoutMs: number,
  quietMs = 1500,
): Promise<void> {
  const start = performance.now();
  let previousTotal = -1;
  let quietSince = performance.now();
  while (performance.now() - start < timeoutMs) {
    await delay(50);
    const { buckets } = paintProfiler.snapshot();
    let total = 0;
    for (const key of LARGE_CHUNK_SETTLE_KEYS)
      total += buckets[key]?.calls ?? 0;
    if (total !== previousTotal) {
      previousTotal = total;
      quietSince = performance.now();
      continue;
    }
    const quietFor = performance.now() - quietSince;
    if (total > 0 && quietFor >= quietMs) return;
    // Nothing recorded at all: the window did no paint work, don't spin.
    if (total === 0 && quietFor >= NOTHING_LANDED_GIVEUP_MS) return;
  }
}

/** Run `action` inside one profiler window and collect the large-chunk row. */
async function profileLargeChunkWindow(
  settleTimeoutMs: number,
  action: () => Promise<void>,
): Promise<LargeChunkWindow> {
  paintProfiler.enabled = true;
  paintProfiler.autoFlush = false;
  paintProfiler.resetWindow();
  const pacing = startFramePacing();
  const start = performance.now();
  let error: string | undefined;
  try {
    await action();
    await waitForLargeChunkSettle(settleTimeoutMs);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const wallMs = roundTenth(performance.now() - start);
  const frames = pacing.stop();
  const snapshot = paintProfiler.snapshot();
  const timings: LargeChunkWindow["timings"] = {};
  for (const key of LARGE_CHUNK_TIMING_KEYS) {
    const bucket = snapshot.buckets[key];
    if (bucket === undefined) continue;
    timings[key] = {
      totalMs: roundTenth(bucket.totalMs),
      calls: bucket.calls,
      maxMs: roundTenth(bucket.maxMs),
    };
  }
  const counters: Record<string, number> = {};
  for (const key of LARGE_CHUNK_COUNTER_KEYS) {
    const count = snapshot.counters[key];
    if (count !== undefined) counters[key] = count;
  }
  const summary = paintProfiler.renderSummary();
  paintProfiler.enabled = false;
  paintProfiler.autoFlush = true;
  paintProfiler.resetWindow();
  return {
    ok: error === undefined,
    ...(error !== undefined && { error }),
    wallMs,
    frames,
    timings,
    counters,
    summary,
    jsHeapMb: heapMegabytes(),
  };
}

/** Panel-centre client point and CSS pixels per target voxel. */
function voxelToClient(): (
  point: readonly [number, number],
) => [number, number] {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const voxelsPerPixel = viewer.crossSectionScale.value as number;
  const rect = findDispatchTarget().getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  return ([voxelX, voxelY]) => [
    centerX + voxelX / voxelsPerPixel,
    centerY + voxelY / voxelsPerPixel,
  ];
}

/**
 * Draw one unmasked brush stroke along `input.path` and profile it, from the
 * first pointer event until the mirror and the end-of-stroke record settle.
 */
export async function strokeVoxelPath(
  input: VoxelStrokeInput,
): Promise<LargeChunkWindow> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  await waitForActiveSession(host, 120000);
  // Select first: the session's first brush activation seeds the size from the
  // zoom (`maybeSeedBrushSizeFromZoom`) and would overwrite a radius set before.
  host.selectTool("painting.brush");
  const state = host.painting.state;
  if (presetMask === undefined) presetMask = state.getState().mask;
  state.patchState({
    radius: input.radius,
    mask: input.masked === true ? presetMask : undefined,
    // A fill stamp leaves this on, and with it a keep-every-voxel mask is
    // skipped altogether (`maskKeepsEveryVoxel`).
    fillClosedPaths: false,
  });
  await nextFrame();
  const target = findDispatchTarget();
  const toClient = voxelToClient();
  const stepMs = input.stepMs ?? 80;
  const pointer = (
    type: string,
    point: readonly [number, number],
    buttons: number,
  ) => {
    const [clientX, clientY] = toClient(point);
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: type === "pointermove" ? -1 : 0,
        buttons,
      }),
    );
  };
  return profileLargeChunkWindow(input.settleTimeoutMs ?? 120000, async () => {
    const [first, ...rest] = input.path;
    pointer("pointerdown", first, 1);
    for (const point of rest) {
      await delay(stepMs);
      pointer("pointermove", point, 1);
    }
    pointer("pointerup", input.path[input.path.length - 1], 0);
  });
}

export interface UndoAllResult {
  /** Undos that ran before `canUndo` went false (or `max` was reached). */
  readonly undone: number;
  readonly canUndoAfter: boolean;
  readonly undos: readonly LargeChunkWindow[];
}

/** Undo until the history is empty (at most `max` times), profiling each. */
export async function undoAll(
  input: { max?: number; settleTimeoutMs?: number } = {},
): Promise<UndoAllResult> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const session = viewer?.editSessionHost?.activeSession?.value;
  if (session === undefined) {
    return { undone: 0, canUndoAfter: false, undos: [] };
  }
  const max = input.max ?? 50;
  const undos: LargeChunkWindow[] = [];
  while (undos.length < max && session.getHistory().canUndo) {
    undos.push(
      await profileLargeChunkWindow(
        input.settleTimeoutMs ?? 120000,
        async () => {
          await session.undo();
        },
      ),
    );
  }
  return {
    undone: undos.length,
    canUndoAfter: session.getHistory().canUndo,
    undos,
  };
}

/** The session's undo/redo availability, and the 3D preview status. */
export function sessionHistoryStatus(): {
  canUndo: boolean;
  canRedo: boolean;
  preview: unknown;
} {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  const history = host?.activeSession?.value?.getHistory?.();
  return {
    canUndo: history?.canUndo ?? false,
    canRedo: history?.canRedo ?? false,
    preview: host?.paintedVolumePreviewSummary?.value,
  };
}

/**
 * Commit the active session and open it again with the same config: the
 * cross-session "committed edits stay visible and editable" path. Reads the
 * host's private session config — a benchmark-only reach-in.
 */
export async function commitAndReenterSession(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  const host = viewer?.editSessionHost;
  try {
    const config = host.activeSessionConfig;
    if (config === undefined) throw new Error("no active session config");
    // Back to the navigation tool first: committing with a paint tool's panel
    // open throws from that panel's render (it reads `painting.state` after
    // the session is gone). Not what this helper measures; the UI never
    // commits that way (its Exit discards).
    host.selectTool(undefined);
    await nextFrame();
    await host.commitActive();
    await host.openSession(config);
    await waitForActiveSession(host, 120000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Discard the active session (rolls patches back to the last commit). */
export async function discardActiveSession(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const viewer = (globalThis as unknown as { viewer?: Any }).viewer;
  try {
    await viewer?.editSessionHost?.discardActive();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Convenience: full sweep in one call (the spec prefers prepare + step). */
export async function runEditPaintBench(
  opts: EditPaintBenchOptions = {},
): Promise<EditPaintBenchResult[]> {
  await prepareEditPaintBench(opts);
  const sizes = opts.sizes ?? DEFAULT_SIZES;
  const cases = opts.cases ?? ["masked-brush", "unmasked-brush", "eraser"];
  const results: EditPaintBenchResult[] = [];
  for (const c of cases) {
    for (const size of sizes) {
      results.push(
        await stepEditPaintBench({
          case: c,
          size,
          settleTimeoutMs: opts.settleTimeoutMs,
          renderFramesAfterStroke: opts.renderFramesAfterStroke,
          strokePoints: opts.strokePoints,
          strokeStepMs: opts.strokeStepMs,
        }),
      );
    }
  }
  finishEditPaintBench();
  return results;
}

// Attach to the window so Playwright can call the steps. Harmless dev surface,
// mirroring `__paintProfiler` — only does work when invoked.
Object.assign(globalThis as unknown as Record<string, unknown>, {
  __editPaintBench: runEditPaintBench,
  __editPaintBenchPrepare: prepareEditPaintBench,
  __editPaintBenchWarmup: warmupEditPaintBench,
  __editPaintBenchStep: stepEditPaintBench,
  __editPaintBenchFinish: finishEditPaintBench,
  // TM-331 phase 2 — correctness read-back.
  __editPaintBenchReadback: readbackEditPaintTarget,
  __editPaintBenchStampReadback: stampAndReadbackEditPaint,
  __editPaintBenchClearTarget: clearEditPaintTargetPatches,
  // TM-373 — large-chunk benchmark.
  __editPaintBenchVoxelStroke: strokeVoxelPath,
  __editPaintBenchUndoAll: undoAll,
  __editPaintBenchHistory: sessionHistoryStatus,
  __editPaintBenchCommitAndReenter: commitAndReenterSession,
  __editPaintBenchDiscard: discardActiveSession,
});
