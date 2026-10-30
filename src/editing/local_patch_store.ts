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
 * @file Top-level voxel patch store owned by an `EditSessionHost`-per-layer slot.
 *
 * One LocalPatchStore per writable segmentation layer, holding a single
 * LocalPatchSource for the active resolution. Multi-resolution support and
 * IndexedDB persistence are deferred to a later iteration.
 */

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import type { ChunkKey } from "#src/editing/local_patch_source.js";
import {
  chunkGridKey,
  LocalPatchSource,
} from "#src/editing/local_patch_source.js";
import type { DebouncedFunction } from "#src/util/animation_frame_debounce.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal, Signal } from "#src/util/signal.js";

/**
 * One change to the store's patches, reported by `chunkChanged`. `box` is the
 * chunk-local inclusive box whose voxels may have changed; `null` means the
 * whole chunk.
 */
export type PatchChunkChange =
  | { kind: "chunk"; key: ChunkKey; box: ChunkVoxelBox | null }
  | { kind: "all-cleared" };

export class LocalPatchStore extends RefCounted {
  readonly source: LocalPatchSource;
  readonly changed = new NullarySignal();
  /**
   * Fired synchronously on every patch change, before the (possibly
   * frame-debounced) `changed`. A separate channel so a second consumer never
   * competes for the 2D texture cache's one-shot `pendingUpload`, nor relies on
   * `source.dirtyKeys`, which nothing drains.
   */
  readonly chunkChanged = new Signal<(change: PatchChunkChange) => void>();
  private readonly flushDebounced: DebouncedFunction;

  constructor() {
    super();
    this.source = this.registerDisposer(new LocalPatchSource());
    this.flushDebounced = animationFrameDebounce(() => {
      this.changed.dispatch();
    });
  }

  /**
   * Coalesce many voxel writes within a single animation frame into one
   * `changed` dispatch (which will be the redraw trigger in Phase 1).
   */
  scheduleGPUFlush(): void {
    this.flushDebounced();
  }

  /**
   * Synchronously fire `changed` (and cancel any pending debounced flush).
   * Used for non-drag operations such as fill, where there is no drag-rate
   * burst of writes.
   */
  flushImmediately(): void {
    this.flushDebounced.cancel();
    this.changed.dispatch();
  }

  /**
   * Atomically replace a whole chunk's voxel buffer and schedule a GPU flush;
   * used by `PatchMirror` to mirror library DirtyTracker chunk events.
   * `patched` is the per-voxel mask; see `LocalPatchSource.writeFullChunk`
   * for the default-when-omitted behavior.
   */
  writeFullChunk(
    chunkGridPosition: ArrayLike<number>,
    chunkDataSize: ArrayLike<number>,
    data: BigUint64Array,
    patched?: Uint8Array,
  ): void {
    this.source.writeFullChunk(chunkGridPosition, chunkDataSize, data, patched);
    this.dispatchChunkChanged(chunkGridPosition, null);
    this.scheduleGPUFlush();
  }

  /**
   * Record that `PatchMirror` mutated a chunk's buffers in place (fused
   * diff/widen path) and schedule the coalesced GPU flush. The chunk's own
   * `pendingUpload` carries the stale sub-box for the texture cache; `box`, when
   * given, is the same chunk-local box for `chunkChanged` listeners (omitted →
   * whole chunk).
   */
  noteChunkMutated(
    chunkGridPosition: ArrayLike<number>,
    box?: ChunkVoxelBox,
  ): void {
    this.source.dirtyKeys.add(chunkGridKey(chunkGridPosition));
    this.dispatchChunkChanged(chunkGridPosition, box ?? null);
    this.scheduleGPUFlush();
  }

  /** Drop every patch in this store. */
  clearAll(): void {
    this.source.clearAll();
    this.chunkChanged.dispatch({ kind: "all-cleared" });
    this.flushImmediately();
  }

  /**
   * Drop a single patched chunk by grid position. Used when discarding an
   * active edit session: chunks dirtied during the session that have NO
   * committed snapshot to revert to need their patch removed so the base
   * layer renders through.
   */
  clearChunk(chunkGridPosition: ArrayLike<number>): void {
    if (this.source.clearChunk(chunkGridKey(chunkGridPosition))) {
      this.dispatchChunkChanged(chunkGridPosition, null);
      this.scheduleGPUFlush();
    }
  }

  private dispatchChunkChanged(
    chunkGridPosition: ArrayLike<number>,
    box: ChunkVoxelBox | null,
  ): void {
    this.chunkChanged.dispatch({
      kind: "chunk",
      key: chunkGridKey(chunkGridPosition),
      box,
    });
  }

  /** Convenience: count total patches across all chunks. Used by tests/UI. */
  countPatchedVoxels(): number {
    let n = 0;
    for (const chunk of this.source.chunks.values()) {
      n += chunk.countPatchedVoxels();
    }
    return n;
  }
}
