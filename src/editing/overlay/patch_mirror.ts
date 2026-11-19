/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  EditSession,
  LayerId,
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
  Resolution,
} from "@zettaai/edit-session";
import { ChunkId } from "@zettaai/edit-session";

import type { NgLogger } from "#src/editing/adapters/ng_logger.js";
import type {
  ChunkVoxelBox,
  LocalPatchChunk,
} from "#src/editing/local_patch_chunk.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { takePaintedSubBox } from "#src/editing/overlay/painted_subbox_registry.js";
import { sessionChunkDataSize } from "#src/editing/overlay/session_chunk_data_size.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import { RefCounted } from "#src/util/disposable.js";

/**
 * Read the pristine baseline bytes for an overlay chunk — what the base
 * segmentation render layer would show absent any patches. PatchMirror
 * diffs overlay bytes against this to derive the per-voxel patched mask.
 */
export type BaselineChunkReader = (
  coord: OverlayCoord,
) => Promise<ReadonlyChunkVoxelBuffer>;

/**
 * {@link BaselineChunkReader} for one box (chunk-local, inclusive) only: the
 * same baseline values, as a dense box-sized buffer in x-fastest order
 * (TM-373, PR 2). A bounded mirror pass reads this instead of the whole chunk.
 */
export type BaselineBoxReader = (
  coord: OverlayCoord,
  box: ChunkVoxelBox,
) => Promise<ReadonlyChunkVoxelBuffer>;

/**
 * Read THIS SESSION's own baseline for a chunk — the bytes it started from.
 *
 * Undefined when the session cannot say, which is not the same as "use the
 * datasource instead": the datasource is the thing being replaced, and
 * diffing against it marks every voxel a colleague moved and paints this
 * session's untouched baseline over them. A reader that falls through to it
 * silently reintroduces exactly that. {@link PatchMirror.resyncAfterRefetch}
 * leaves such a chunk's mask alone rather than guess.
 */
export type SessionBaselineReader = (
  coord: OverlayCoord,
) => Promise<ReadonlyChunkVoxelBuffer | undefined>;

/**
 * Delays before each automatic retry of a chunk whose sync failed. Its length
 * caps the retries; a chunk that exhausts them keeps its failed request
 * queued, so the next commit to it still repairs the mirror.
 */
const RESYNC_BACKOFF_MS = [100, 500, 2000];

/**
 * Most painted boxes a chunk queues while a pass is in flight. Past it they
 * merge into their union: still a superset of every changed voxel, read and
 * fused as one box, never more than the whole chunk.
 */
export const MAX_PENDING_BOXES = 32;

type ReadFrom = "datasource" | "edit-baseline";

/**
 * Per-chunk sync bookkeeping: the passes this chunk still owes, each with the
 * baseline it must read. See {@link PatchMirror.driveChunk}.
 */
interface ChunkSyncState {
  /** A pass is running; a concurrent pass would race its fuse. */
  inFlight: boolean;
  /**
   * A full pass against THIS SESSION's baseline is owed
   * (`resyncAfterRefetch`), possibly a retry of one that failed.
   */
  editBaselineRequested: boolean;
  /** Resolved once the owed edit-baseline pass has run (or on dispose). */
  editBaselineWaiters: (() => void)[];
  /**
   * A full datasource pass is owed: a commit without a hint (history replay,
   * undo-to-baseline, save rebaseline), or a failed datasource pass whose
   * box was already consumed. Only a full scan can rediscover such voxels.
   */
  needsResync: boolean;
  /**
   * Bounded datasource passes owed: the painted box of each commit that
   * landed while a pass was in flight. A list, not one bbox: the union of a
   * long diagonal stroke's boxes is most of the chunk.
   */
  pendingBoxes: ChunkVoxelBox[];
  /** Consecutive failed passes, bounding the automatic retries. */
  failedAttempts: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

/** One pass taken off a chunk's queue. */
interface SyncPass {
  readonly readFrom: ReadFrom;
  /** Boxes of a bounded pass; undefined → the whole chunk. */
  readonly boxes: readonly ChunkVoxelBox[] | undefined;
  /** Callers waiting on this pass (edit-baseline only). */
  readonly waiters: readonly (() => void)[];
}

/**
 * The next pass a chunk owes, removed from its queue. An edit-baseline pass
 * first: the caller is refetching the datasource and waits for it. Then a
 * full datasource scan, then the painted boxes. A full pass of either kind
 * covers every box queued before it starts, so it drops them (and the
 * edit-baseline pass also covers a pending full datasource scan).
 */
function takeNextPass(state: ChunkSyncState): SyncPass | undefined {
  if (state.editBaselineRequested) {
    state.editBaselineRequested = false;
    state.needsResync = false;
    state.pendingBoxes = [];
    return {
      readFrom: "edit-baseline",
      boxes: undefined,
      waiters: state.editBaselineWaiters.splice(0),
    };
  }
  if (state.needsResync) {
    state.needsResync = false;
    state.pendingBoxes = [];
    return { readFrom: "datasource", boxes: undefined, waiters: [] };
  }
  if (state.pendingBoxes.length > 0) {
    const boxes = state.pendingBoxes;
    state.pendingBoxes = [];
    return { readFrom: "datasource", boxes, waiters: [] };
  }
  return undefined;
}

/** Queue a painted box; past {@link MAX_PENDING_BOXES}, merge them all. */
function queueBox(state: ChunkSyncState, box: ChunkVoxelBox): void {
  state.pendingBoxes.push(box);
  if (state.pendingBoxes.length > MAX_PENDING_BOXES) {
    state.pendingBoxes = [unionOfBoxes(state.pendingBoxes)];
  }
}

/** The smallest box containing every box in `boxes` (non-empty). */
export function unionOfBoxes(boxes: readonly ChunkVoxelBox[]): ChunkVoxelBox {
  const [first, ...rest] = boxes;
  const union = { ...first };
  for (const box of rest) {
    union.x0 = Math.min(union.x0, box.x0);
    union.y0 = Math.min(union.y0, box.y0);
    union.z0 = Math.min(union.z0, box.z0);
    union.x1 = Math.max(union.x1, box.x1);
    union.y1 = Math.max(union.y1, box.y1);
    union.z1 = Math.max(union.z1, box.z1);
  }
  return union;
}

function isIdle(state: ChunkSyncState): boolean {
  return (
    !state.inFlight &&
    !state.editBaselineRequested &&
    !state.needsResync &&
    state.pendingBoxes.length === 0 &&
    state.editBaselineWaiters.length === 0 &&
    state.failedAttempts === 0 &&
    state.retryTimer === undefined
  );
}

function keyOfCoord(coord: OverlayCoord): string {
  return `${coord.layerId}|${coord.resolution}|${coord.chunkId}`;
}

/**
 * One-way mirror that propagates dirty-chunk events from the library's
 * `EditOverlayStore` into a per-layer GPU `LocalPatchStore`. The mirror is
 * single-step (library -> GPU only) and never writes back. Created and torn
 * down by `EditSessionHost` per writable layer; coalescing of bursty writes
 * is handled inside `LocalPatchStore.scheduleGPUFlush`.
 *
 * The per-voxel patched mask is derived by comparing overlay bytes against
 * baseline bytes. The baseline here MUST be the datasource render base — the
 * decoded bytes the base segmentation render layer shows from `source.chunks`
 * (via `readBaseline` → `NgChunkSource.readDatasourceBaseline`) — NOT the edit
 * baseline (saved/committed bytes). The render composites the GPU patch where
 * the mask is 1 and falls back to the datasource chunk where it is 0, so the
 * composite equals the overlay only when `patched = (overlay !== datasourceBase)`.
 * Diffing against the saved/committed bytes instead would drop just-saved voxels
 * out of the mask (they equal that baseline) and revert them to the stale
 * datasource value on screen (TM-352). Voxels where `overlay[i] !== baseline[i]`
 * are marked patched. Voxels the user erased back to the datasource value
 * compare equal and stay unpatched — the visible result is identical to "not
 * patched", so the mask is correct in practice.
 */
export class PatchMirror extends RefCounted {
  private readonly chunkDataSizeByResolution = new Map<
    Resolution,
    readonly [number, number, number]
  >();
  private readonly syncState = new Map<string, ChunkSyncState>();

  constructor(
    private readonly session: EditSession,
    private readonly layerId: LayerId,
    private readonly store: LocalPatchStore,
    private readonly logger: NgLogger,
    private readonly readBaseline: BaselineChunkReader,
    /**
     * This session's own baseline — the saved/committed bytes it started from.
     *
     * Only {@link resyncAfterRefetch} uses it, and the difference from
     * {@link readBaseline} is the whole point. Diffed against the overlay it
     * yields "what THIS SESSION changed", which is the right mask exactly when
     * the datasource is about to be refetched: voxels nobody here painted fall
     * out of the mask and the refetched chunk shows through, colleague's work
     * included. Diffing against the datasource instead would mark every voxel
     * a colleague moved and paint this session's untouched baseline over it.
     */
    private readonly readEditBaseline: SessionBaselineReader,
    /**
     * {@link readBaseline} by box, for a bounded datasource pass (TM-373). On
     * a 4096² chunk the full read decodes 16.7M voxels on every brush move;
     * this reads the brush's box. Absent → bounded passes read the whole
     * chunk, as before. Full passes (no hint, a failed pass, a retry, the
     * edit baseline of `resyncAfterRefetch`) always read the whole chunk.
     */
    private readonly readBaselineBox?: BaselineBoxReader,
  ) {
    super();
    const unsubscribe = this.session.dirty.on("chunk-changed", (payload) => {
      if (payload.coord.layerId !== this.layerId) return;
      // Consume the painted-sub-box hint SYNCHRONOUSLY here — this handler runs
      // synchronously from the library's `commitWrites`, so the hint for this
      // exact commit is live now and would be ambiguous if read later in the
      // async `syncChunk`. A paint write left a hint (→ bounded fuse); any other
      // commit (history replay / undo-to-baseline / save rebaseline) left none
      // (→ full-chunk scan, which those paths require). See the registry docs.
      const scanBox = takePaintedSubBox(
        payload.coord.layerId,
        payload.coord.resolution,
        payload.coord.chunkId,
      );
      void this.driveChunk(payload.coord, scanBox);
    });
    this.registerDisposer(() => unsubscribe());
    this.registerDisposer(() => {
      for (const state of this.syncState.values()) {
        if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
        for (const resolve of state.editBaselineWaiters.splice(0)) resolve();
      }
      this.syncState.clear();
    });
  }

  /**
   * Re-derive the mask for these chunks as "what this session changed", for a
   * caller that is refetching their datasource chunks.
   *
   * The bytes the ordinary mask was derived from are on their way out, and
   * leaving it alone leaves the composite built from two versions: the patch
   * keeps painting this session's older values over the newer ones that come
   * back, and a colleague's work reads as lost until the page is reloaded.
   * Against the edit baseline the mask instead marks only this session's own
   * edits, so everything else renders from the chunk that arrives.
   *
   * Always a full-chunk scan — a sub-box hint describes a paint write, and
   * this is not one. Chunks sync one at a time through the same per-chunk
   * queue as a commit, so a resync and a stroke cannot race each other's
   * fuse. Each chunk's promise resolves once ITS edit-baseline pass has run,
   * even when a stroke's pass was in flight when it was asked for (TM-373).
   */
  async resyncAfterRefetch(coords: readonly OverlayCoord[]): Promise<void> {
    for (const coord of coords) {
      if (this.wasDisposed) return;
      if (coord.layerId !== this.layerId) continue;
      await this.driveChunk(coord, undefined, "edit-baseline");
    }
  }

  /**
   * Queue a pass for one chunk and drain its queue unless a pass is already
   * running (that pass drains it when it ends).
   *
   * A bounded (`scanBox`) fuse only mirrors the voxels of the commit that
   * carried the hint, so every hint must reach a pass: a commit that lands
   * while a pass is awaiting its reads queues its box, and the next pass is
   * bounded over all of them (TM-373; it used to fall back to a full scan,
   * which on a 4096² chunk is a full decode). Only a commit WITHOUT a hint,
   * or a pass that fails after its box was consumed, owes a full scan.
   *
   * The baseline a pass reads travels with its request: a painted box always
   * diffs against the datasource, a `resyncAfterRefetch` always against the
   * edit baseline, whichever pass is running when they arrive. A failed pass
   * keeps its request queued in its own mode and retries on a bounded
   * backoff, so recovery does not depend on the user painting the chunk
   * again.
   *
   * Resolves when the request has been served: for an edit-baseline request,
   * once its pass has run (successfully or not) or the chunk has stopped
   * retrying on its own (the request then waits for the next commit); otherwise once this call's
   * drain ends, or at once when another pass is draining.
   */
  private driveChunk(
    coord: OverlayCoord,
    scanBox: ChunkVoxelBox | undefined,
    readFrom: ReadFrom = "datasource",
  ): Promise<void> {
    const chunkKey = keyOfCoord(coord);
    const state = this.getSyncState(chunkKey);
    let served: Promise<void> | undefined;
    if (readFrom === "edit-baseline") {
      state.editBaselineRequested = true;
      served = new Promise((resolve) => {
        state.editBaselineWaiters.push(resolve);
      });
    } else if (scanBox === undefined) {
      state.needsResync = true;
    } else {
      queueBox(state, scanBox);
    }
    const drained = state.inFlight
      ? Promise.resolve()
      : this.drainChunk(coord, chunkKey, state);
    return served ?? drained;
  }

  /** Run the chunk's owed passes until none is left or one fails. */
  private async drainChunk(
    coord: OverlayCoord,
    chunkKey: string,
    state: ChunkSyncState,
  ): Promise<void> {
    if (state.retryTimer !== undefined) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
    state.inFlight = true;
    try {
      for (;;) {
        if (this.wasDisposed) return;
        const pass = takeNextPass(state);
        if (pass === undefined) return;
        const ok = await this.syncChunk(coord, pass.boxes, pass.readFrom);
        for (const resolve of pass.waiters) resolve();
        if (!ok) {
          // Re-queue the failed pass in its own mode, as a full scan: its
          // box, if it had one, is consumed.
          if (pass.readFrom === "edit-baseline") {
            state.editBaselineRequested = true;
          } else {
            state.needsResync = true;
          }
          if (!this.scheduleRetry(coord, chunkKey, state)) {
            // Nothing runs this chunk on its own any more, so an edit-baseline
            // request queued behind the failed pass would never be served.
            // Release its callers (a refetch resync awaits each chunk in
            // turn); the request stays queued for the next commit.
            for (const resolve of state.editBaselineWaiters.splice(0)) {
              resolve();
            }
          }
          return;
        }
        state.failedAttempts = 0;
      }
    } finally {
      state.inFlight = false;
      if (this.wasDisposed) {
        for (const resolve of state.editBaselineWaiters.splice(0)) resolve();
      }
      // Keep the map proportional to the chunks that are behind or retrying,
      // not to every chunk the session has ever painted. A later commit just
      // recreates the entry.
      if (isIdle(state)) this.syncState.delete(chunkKey);
    }
  }

  private getSyncState(chunkKey: string): ChunkSyncState {
    let state = this.syncState.get(chunkKey);
    if (state === undefined) {
      state = {
        inFlight: false,
        editBaselineRequested: false,
        editBaselineWaiters: [],
        needsResync: false,
        pendingBoxes: [],
        failedAttempts: 0,
        retryTimer: undefined,
      };
      this.syncState.set(chunkKey, state);
    }
    return state;
  }

  /** Returns whether a retry is scheduled. */
  private scheduleRetry(
    coord: OverlayCoord,
    chunkKey: string,
    state: ChunkSyncState,
  ): boolean {
    if (this.wasDisposed) return false;
    if (state.failedAttempts >= RESYNC_BACKOFF_MS.length) {
      // Out of retries. `failedAttempts` is deliberately not reset, so this
      // chunk stops scheduling its own retries for the rest of the session --
      // a chunk that has failed this often is failing for a reason a timer
      // will not fix. The failed request stays queued, so any later commit to
      // this chunk still runs it and repairs the chunk.
      this.logger.error(
        "overlay",
        `PatchMirror is no longer retrying chunk ${chunkKey} on its own ` +
          `(it already exhausted ${RESYNC_BACKOFF_MS.length} backoff ` +
          `attempts); its overlay is stale until the next write to it or a ` +
          `session reload`,
      );
      return false;
    }
    const delay = RESYNC_BACKOFF_MS[state.failedAttempts];
    state.failedAttempts++;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      if (this.wasDisposed) return;
      // The failed request is still queued in its own mode; just drain.
      if (!state.inFlight) void this.drainChunk(coord, chunkKey, state);
    }, delay);
    return true;
  }

  /**
   * Run one fuse pass: over the whole chunk (`boxes` undefined) or over each
   * box. Returns `false` when the pass did not complete, so the caller can
   * queue a full rescan rather than leaving the chunk behind.
   */
  private async syncChunk(
    coord: OverlayCoord,
    boxes: readonly ChunkVoxelBox[] | undefined,
    readFrom: ReadFrom = "datasource",
  ): Promise<boolean> {
    const chunkKey = keyOfCoord(coord);
    try {
      const chunkDataSize = this.resolveChunkDataSize(coord.resolution);
      if (chunkDataSize === undefined) {
        this.logger.error(
          "overlay",
          `PatchMirror sync failed for chunk ${chunkKey}: no chunkDataSize ` +
            `for resolution ${coord.resolution} on layer ${coord.layerId}`,
        );
        return false;
      }
      const prof = paintProfiler.enabled;
      let t = prof ? performance.now() : 0;
      const plan = this.planBaselineReads(chunkDataSize, boxes, readFrom);
      if (plan.kind === "nothing") return true;
      const [overlayBuffer, baseline] = await Promise.all([
        this.session.overlay.read(coord),
        this.readPlannedBaseline(coord, plan),
      ]);
      // No baseline means no way to tell this session's edits from the bytes it
      // merely loaded. Leave the mask as it stands: the paint keeps rendering,
      // which is the safe half of the trade.
      if (baseline === undefined) return true;
      if (prof) {
        paintProfiler.record("5.mirror.read(io)", performance.now() - t);
      }
      if (this.wasDisposed) return true;
      const { x, y, z } = ChunkId.toCoord(coord.chunkId);
      const chunkGridPosition = new Float32Array([x, y, z]);
      const chunk = this.store.source.getOrCreateChunk(
        chunkGridPosition,
        chunkDataSize,
      );
      if (prof) t = performance.now();
      const overlayView = overlayBuffer.asView();
      const changes: ChunkVoxelBox[] = [];
      const noteChange = (change: ChunkVoxelBox | null) => {
        if (change !== null) changes.push(change);
      };
      if (baseline.kind === "boxes") {
        baseline.boxes.forEach((box, i) =>
          noteChange(
            fuseOverlayIntoChunkBox(
              chunk,
              overlayView,
              baseline.buffers[i].asView(),
              box,
            ),
          ),
        );
      } else if (boxes === undefined) {
        noteChange(
          fuseOverlayIntoChunk(chunk, overlayView, baseline.buffer.asView()),
        );
      } else {
        for (const box of boxes) {
          noteChange(
            fuseOverlayIntoChunk(
              chunk,
              overlayView,
              baseline.buffer.asView(),
              box,
            ),
          );
        }
      }
      if (prof) {
        paintProfiler.record("5.mirror.fuse(cpu)", performance.now() - t);
        paintProfiler.count("mirror.syncs", 1);
        // TM-373: a full pass is the expensive one on large chunks; split the
        // count so the perf suite can see how many passes lost their box.
        paintProfiler.count(
          boxes === undefined ? "mirror.syncs.full" : "mirror.syncs.bounded",
          1,
        );
      }
      if (changes.length > 0) {
        const change = unionOfBoxes(changes);
        chunk.dirty = true;
        chunk.mergePendingUpload(change);
        // No change reports nothing, so the empty chunk `getOrCreateChunk`
        // may have just created stays silent — harmless, it holds no patch.
        this.store.noteChunkMutated(chunkGridPosition, change);
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        "overlay",
        `PatchMirror sync failed for chunk ${chunkKey}: ${message}`,
      );
      return false;
    }
  }

  /**
   * What baseline a pass reads. A bounded datasource pass with a box reader
   * reads each box (clamped to the chunk first, so the read and the fuse
   * agree on it; boxes empty after clamping are dropped). Everything else
   * reads the whole chunk.
   */
  private planBaselineReads(
    chunkDataSize: readonly [number, number, number],
    boxes: readonly ChunkVoxelBox[] | undefined,
    readFrom: ReadFrom,
  ): BaselineReadPlan {
    if (readFrom === "edit-baseline") return { kind: "edit-baseline" };
    const readBox = this.readBaselineBox;
    if (boxes === undefined || readBox === undefined) {
      return { kind: "chunk" };
    }
    const clamped = boxes
      .map((box) => clampScanBox(chunkDataSize, box))
      .filter((box) => !isEmptyBox(box));
    if (clamped.length === 0) return { kind: "nothing" };
    return { kind: "boxes", boxes: clamped, readBox };
  }

  private async readPlannedBaseline(
    coord: OverlayCoord,
    plan: Exclude<BaselineReadPlan, { kind: "nothing" }>,
  ): Promise<PlannedBaseline | undefined> {
    switch (plan.kind) {
      case "edit-baseline": {
        const buffer = await this.readEditBaseline(coord);
        return buffer === undefined ? undefined : { kind: "chunk", buffer };
      }
      case "chunk":
        return { kind: "chunk", buffer: await this.readBaseline(coord) };
      case "boxes": {
        const buffers = await Promise.all(
          plan.boxes.map((box) => plan.readBox(coord, box)),
        );
        return { kind: "boxes", boxes: plan.boxes, buffers };
      }
    }
  }

  private resolveChunkDataSize(
    resolution: Resolution,
  ): readonly [number, number, number] | undefined {
    const cached = this.chunkDataSizeByResolution.get(resolution);
    if (cached !== undefined) return cached;
    const size = sessionChunkDataSize(this.session, this.layerId, resolution);
    if (size === undefined) return undefined;
    this.chunkDataSizeByResolution.set(resolution, size);
    return size;
  }
}

type BaselineReadPlan =
  | { readonly kind: "nothing" }
  | { readonly kind: "edit-baseline" }
  | { readonly kind: "chunk" }
  | {
      readonly kind: "boxes";
      readonly boxes: readonly ChunkVoxelBox[];
      readonly readBox: BaselineBoxReader;
    };

type PlannedBaseline =
  | { readonly kind: "chunk"; readonly buffer: ReadonlyChunkVoxelBuffer }
  | {
      readonly kind: "boxes";
      readonly boxes: readonly ChunkVoxelBox[];
      readonly buffers: readonly ReadonlyChunkVoxelBuffer[];
    };

function isEmptyBox(box: ChunkVoxelBox): boolean {
  return box.x1 < box.x0 || box.y1 < box.y0 || box.z1 < box.z0;
}

type NumericVoxelView =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array;

function isNumericVoxelView(view: ArrayBufferView): view is NumericVoxelView {
  return (
    view instanceof Uint8Array ||
    view instanceof Uint16Array ||
    view instanceof Uint32Array ||
    view instanceof Int8Array ||
    view instanceof Int16Array ||
    view instanceof Int32Array
  );
}

/**
 * Where the baseline voxels of a fuse live: the whole chunk, or a dense
 * buffer of one box (chunk-local, inclusive) in x-fastest order.
 */
interface BaselineLayout {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly sizeX: number;
  readonly sizeY: number;
}

/**
 * Fused widen + diff + write: one pass over the chunk that updates
 * `chunk.data` (the BigUint64 GPU mirror) and `chunk.patched`
 * (`overlay !== baseline`) in place, and returns the chunk-local bbox of
 * voxels whose mirrored state actually changed — or `null` when the chunk is
 * already up to date.
 *
 * `LocalPatchStore` stores ONE BigUint64 per voxel (the GPU patch texture is
 * RG32UI = 64 bits per voxel). For sub-uint64 source types the previous
 * implementation widened via a `BigInt()` call per voxel into a fresh
 * BigUint64Array (plus a second widened baseline array and a third diff
 * array) — the dominant per-chunk CPU cost. Here the numeric path instead
 * writes the `(lo32, hi32)` pair directly through a Uint32Array view of
 * `chunk.data` (little-endian: low word first, matching the RG32UI upload
 * layout), so no BigInt and no temporary allocations are involved. Signed
 * types widen via `>>> 0` — the same two's-complement representation
 * `BigInt(v >>> 0)` produced before.
 */
export function fuseOverlayIntoChunk(
  chunk: LocalPatchChunk,
  overlayView: ArrayBufferView & { length: number },
  baselineView: ArrayBufferView & { length: number },
  // P2 (TM-317): when present, only this chunk-local box is scanned — it is a
  // superset of the voxels the firing commit touched, and only touched voxels
  // can change the mirror state, so the (data, patched) updates and the
  // returned change-bbox are byte-identical to a full-chunk scan. Absent →
  // full chunk (history replay / undo-to-baseline / save rebaseline, which can
  // change voxels anywhere and so must scan everything).
  scanBox?: ChunkVoxelBox,
): ChunkVoxelBox | null {
  const volume = chunk.data.length;
  if (overlayView.length !== volume || baselineView.length !== volume) {
    throw new Error(
      `PatchMirror.fuseOverlayIntoChunk: overlay length ${overlayView.length} ` +
        `/ baseline length ${baselineView.length} != chunk volume ${volume}`,
    );
  }
  const [sizeX, sizeY] = chunk.chunkDataSize;
  return fuseScan(
    chunk,
    overlayView,
    baselineView,
    clampScanBox(chunk.chunkDataSize, scanBox),
    { x0: 0, y0: 0, z0: 0, sizeX, sizeY },
  );
}

/**
 * {@link fuseOverlayIntoChunk} over one box whose baseline is a dense buffer
 * of that box only (TM-373, PR 2): what a bounded mirror pass reads instead
 * of the whole baseline chunk. Same `data` / `patched` updates and the same
 * change-bbox as the full-baseline fuse with the same `scanBox`. `box` must
 * be the box the baseline was read for, inside the chunk.
 */
export function fuseOverlayIntoChunkBox(
  chunk: LocalPatchChunk,
  overlayView: ArrayBufferView & { length: number },
  baselineBoxView: ArrayBufferView & { length: number },
  box: ChunkVoxelBox,
): ChunkVoxelBox | null {
  const volume = chunk.data.length;
  const [boxSizeX, boxSizeY, boxSizeZ] = [
    box.x1 - box.x0 + 1,
    box.y1 - box.y0 + 1,
    box.z1 - box.z0 + 1,
  ];
  const [sizeX, sizeY, sizeZ] = chunk.chunkDataSize;
  const insideChunk =
    box.x0 >= 0 &&
    box.y0 >= 0 &&
    box.z0 >= 0 &&
    box.x1 < sizeX &&
    box.y1 < sizeY &&
    box.z1 < sizeZ;
  if (!insideChunk || boxSizeX <= 0 || boxSizeY <= 0 || boxSizeZ <= 0) {
    throw new Error(
      `PatchMirror.fuseOverlayIntoChunkBox: box ${JSON.stringify(box)} is ` +
        `not inside the chunk ${sizeX}×${sizeY}×${sizeZ}`,
    );
  }
  const boxVolume = boxSizeX * boxSizeY * boxSizeZ;
  if (overlayView.length !== volume || baselineBoxView.length !== boxVolume) {
    throw new Error(
      `PatchMirror.fuseOverlayIntoChunkBox: overlay length ` +
        `${overlayView.length} != chunk volume ${volume} or baseline length ` +
        `${baselineBoxView.length} != box volume ${boxVolume}`,
    );
  }
  return fuseScan(chunk, overlayView, baselineBoxView, box, {
    x0: box.x0,
    y0: box.y0,
    z0: box.z0,
    sizeX: boxSizeX,
    sizeY: boxSizeY,
  });
}

/**
 * The scan range of a fuse, clamped to the chunk. A scanBox is chunk-local and
 * already within bounds, but clamp defensively so a malformed hint can never
 * index out of the chunk. No box → the whole chunk.
 */
export function clampScanBox(
  chunkDataSize: ArrayLike<number>,
  scanBox: ChunkVoxelBox | undefined,
): ChunkVoxelBox {
  const [sizeX, sizeY, sizeZ] = [
    chunkDataSize[0],
    chunkDataSize[1],
    chunkDataSize[2],
  ];
  if (scanBox === undefined) {
    return { x0: 0, y0: 0, z0: 0, x1: sizeX - 1, y1: sizeY - 1, z1: sizeZ - 1 };
  }
  return {
    x0: Math.max(0, scanBox.x0),
    y0: Math.max(0, scanBox.y0),
    z0: Math.max(0, scanBox.z0),
    x1: Math.min(sizeX - 1, scanBox.x1),
    y1: Math.min(sizeY - 1, scanBox.y1),
    z1: Math.min(sizeZ - 1, scanBox.z1),
  };
}

/**
 * Hot path (every mirror pass, every brush move): the per-voxel diff over
 * `scan`, with the overlay and the mirror indexed by the chunk and the
 * baseline by `baselineLayout`.
 */
function fuseScan(
  chunk: LocalPatchChunk,
  overlayView: ArrayBufferView & { length: number },
  baselineView: ArrayBufferView & { length: number },
  scan: ChunkVoxelBox,
  baselineLayout: BaselineLayout,
): ChunkVoxelBox | null {
  const volume = chunk.data.length;
  const [sx, sy, sz] = chunk.chunkDataSize;
  const { x0, y0, z0, x1, y1, z1 } = scan;
  const bx0 = baselineLayout.x0;
  const by0 = baselineLayout.y0;
  const bz0 = baselineLayout.z0;
  const bsx = baselineLayout.sizeX;
  const bsy = baselineLayout.sizeY;
  const patched = chunk.patched;
  let minX = sx;
  let minY = sy;
  let minZ = sz;
  let maxX = -1;
  let maxY = -1;
  let maxZ = -1;
  // Bbox of the voxels this pass turned to `patched = 1` (PR 6): grows the
  // chunk's `paintedBounds`. Only changed voxels are visited for it.
  let paintedMinX = sx;
  let paintedMinY = sy;
  let paintedMinZ = sz;
  let paintedMaxX = -1;
  let paintedMaxY = -1;
  let paintedMaxZ = -1;
  if (
    overlayView instanceof BigUint64Array &&
    baselineView instanceof BigUint64Array
  ) {
    const data = chunk.data;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        let i = (z * sy + y) * sx + x0;
        let b = ((z - bz0) * bsy + (y - by0)) * bsx + (x0 - bx0);
        for (let x = x0; x <= x1; x++, i++, b++) {
          const v = overlayView[i];
          const p = v !== baselineView[b] ? 1 : 0;
          if (data[i] === v && patched[i] === p) continue;
          data[i] = v;
          patched[i] = p;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          if (p === 1) {
            if (x < paintedMinX) paintedMinX = x;
            if (x > paintedMaxX) paintedMaxX = x;
            if (y < paintedMinY) paintedMinY = y;
            if (y > paintedMaxY) paintedMaxY = y;
            if (z < paintedMinZ) paintedMinZ = z;
            if (z > paintedMaxZ) paintedMaxZ = z;
          }
        }
      }
    }
  } else if (
    isNumericVoxelView(overlayView) &&
    isNumericVoxelView(baselineView)
  ) {
    const u32 = new Uint32Array(
      chunk.data.buffer,
      chunk.data.byteOffset,
      volume * 2,
    );
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        let i = (z * sy + y) * sx + x0;
        let b = ((z - bz0) * bsy + (y - by0)) * bsx + (x0 - bx0);
        for (let x = x0; x <= x1; x++, i++, b++) {
          const lo = overlayView[i] >>> 0;
          const p = overlayView[i] !== baselineView[b] ? 1 : 0;
          if (u32[2 * i] === lo && u32[2 * i + 1] === 0 && patched[i] === p) {
            continue;
          }
          u32[2 * i] = lo;
          u32[2 * i + 1] = 0;
          patched[i] = p;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          if (p === 1) {
            if (x < paintedMinX) paintedMinX = x;
            if (x > paintedMaxX) paintedMaxX = x;
            if (y < paintedMinY) paintedMinY = y;
            if (y > paintedMaxY) paintedMaxY = y;
            if (z < paintedMinZ) paintedMinZ = z;
            if (z > paintedMaxZ) paintedMaxZ = z;
          }
        }
      }
    }
  } else {
    throw new Error(
      `PatchMirror: unsupported voxel data type ` +
        `${overlayView.constructor.name} / ${baselineView.constructor.name}`,
    );
  }
  if (paintedMaxZ >= 0) {
    chunk.growPaintedBounds({
      x0: paintedMinX,
      y0: paintedMinY,
      z0: paintedMinZ,
      x1: paintedMaxX,
      y1: paintedMaxY,
      z1: paintedMaxZ,
    });
  }
  if (maxZ < 0) return null;
  return { x0: minX, y0: minY, z0: minZ, x1: maxX, y1: maxY, z1: maxZ };
}
