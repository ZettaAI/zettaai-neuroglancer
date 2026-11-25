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
 * @file Background reads for a full recompute of the preview's region.
 *
 * Showing whole selected segments means every chunk of the session region has
 * to be composited at least once (plan §3.12). A pass reads the chunks'
 * datasource baselines with a small cap on reads in flight, so the chunk
 * manager's queue is not flooded, and hands the landed chunks to the preview
 * one at a time; the preview composites them within its frame budget. Reads
 * of chunks the preloader has not fetched yet simply wait for them.
 *
 * Starting a pass aborts the previous one. A failed read leaves its chunk as
 * it was; the next full recompute tries it again.
 */

import type { ChunkId, Logger } from "@zettaai/edit-session";
import { ChunkId as ChunkIdFactory } from "@zettaai/edit-session";

import type { ChunkKey } from "#src/editing/local_patch_source.js";
import { chunkGridKey } from "#src/editing/local_patch_source.js";
import type { PaintedVolumeBaselineReader } from "#src/editing/painted_volume/painted_volume_baseline_cache.js";
import type { BaselineVoxelView } from "#src/editing/painted_volume/painted_volume_occupancy.js";
import { WatchableValue } from "#src/trackable_value.js";

/** `LocalPatchStore` key of a library chunk id (`PatchMirror` stores this way). */
export function chunkKeyOf(chunkId: ChunkId): ChunkKey {
  const { x, y, z } = ChunkIdFactory.toCoord(chunkId);
  return chunkGridKey([x, y, z]);
}

export function chunkIdOfKey(key: ChunkKey): ChunkId {
  const [x, y, z] = key.split(",").map(Number);
  return ChunkIdFactory.fromCoord({ x, y, z });
}

export interface RegionFillChunk {
  readonly chunkId: ChunkId;
  readonly key: ChunkKey;
  readonly baseline: BaselineVoxelView;
}

export interface RegionFillProgress {
  /** Chunks taken by the preview or failed. */
  readonly done: number;
  readonly total: number;
  readonly failed: number;
}

/** Plan §3.12: enough to overlap decode with compositing, not enough to flood. */
const DEFAULT_MAX_READS_IN_FLIGHT = 4;

const IDLE_PROGRESS: RegionFillProgress = { done: 0, total: 0, failed: 0 };

export class PaintedVolumeRegionFill {
  readonly progress = new WatchableValue<RegionFillProgress>(IDLE_PROGRESS);

  private queued: ChunkId[] = [];
  private readonly landed: RegionFillChunk[] = [];
  private readsInFlight = 0;
  private pass: AbortController | undefined;

  constructor(
    private readonly read: PaintedVolumeBaselineReader,
    private readonly onReady: () => void,
    private readonly logger: Logger,
    private readonly maxReadsInFlight = DEFAULT_MAX_READS_IN_FLIGHT,
  ) {}

  /** True while chunks remain to be read or taken. */
  get active(): boolean {
    return (
      this.queued.length > 0 || this.readsInFlight > 0 || this.landed.length > 0
    );
  }

  /** True while a landed chunk waits for `takeReady`. */
  get hasLanded(): boolean {
    return this.landed.length > 0;
  }

  /** Begin a pass over `chunkIds`, abandoning any pass still running. */
  start(chunkIds: readonly ChunkId[]): void {
    this.cancel();
    this.pass = new AbortController();
    this.queued = [...chunkIds];
    this.progress.value = { done: 0, total: chunkIds.length, failed: 0 };
    this.startReads();
  }

  /** The next landed chunk, or `undefined` when none is waiting. */
  takeReady(): RegionFillChunk | undefined {
    const chunk = this.landed.shift();
    if (chunk === undefined) return undefined;
    this.countDone(false);
    this.startReads();
    return chunk;
  }

  cancel(): void {
    this.pass?.abort();
    this.pass = undefined;
    this.queued = [];
    this.landed.length = 0;
    this.readsInFlight = 0;
  }

  /** Landed-but-untaken chunks hold a slot too, bounding memory as well as I/O. */
  private startReads(): void {
    const pass = this.pass;
    if (pass === undefined) return;
    while (
      this.queued.length > 0 &&
      this.readsInFlight + this.landed.length < this.maxReadsInFlight
    ) {
      const chunkId = this.queued.shift()!;
      ++this.readsInFlight;
      this.read(chunkId, pass.signal).then(
        (baseline) => {
          if (pass !== this.pass) return;
          --this.readsInFlight;
          this.landed.push({ chunkId, key: chunkKeyOf(chunkId), baseline });
          this.onReady();
        },
        (error: unknown) => {
          if (pass !== this.pass) return;
          --this.readsInFlight;
          this.logger.warn(
            "session",
            `3D preview: region fill could not read chunk ${chunkKeyOf(chunkId)}`,
            error,
          );
          this.countDone(true);
          this.startReads();
          this.onReady();
        },
      );
    }
  }

  private countDone(failed: boolean): void {
    const { done, total, failed: failedSoFar } = this.progress.value;
    this.progress.value = {
      done: done + 1,
      total,
      failed: failedSoFar + (failed ? 1 : 0),
    };
  }
}
