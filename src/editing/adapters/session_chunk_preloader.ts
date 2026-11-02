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
  ChunkCoord,
  LayerId,
  OverlayCoord,
  Resolution,
} from "@zettaai/edit-session";
import { ChunkId as ChunkIdFactory } from "@zettaai/edit-session";

import type { CapacitySpecification } from "#src/chunk_manager/frontend.js";
import {
  chunkKeyForSource,
  groupByLayerAndResolution,
  makeChunkGridPosition,
} from "#src/editing/adapters/ng_chunk_grid.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";

/** One `(layerId, resolution)` group that failed to (fully) preload. */
export interface ChunkLoadFailure {
  readonly layerId: LayerId;
  readonly resolution: Resolution;
  readonly count: number;
}

/**
 * Progress of the background preload of all session-bbox chunks.
 *
 * - `idle`: no session / preload not running (also the reset state).
 * - `loading`: chunks are being fetched in the background; painting is allowed.
 * - `done`: the preload has finished. Every chunk is loaded unless `failed` or
 *   `skipped` says otherwise (a sparse / absent chunk resolves as a valid zero
 *   baseline and counts as loaded); `failed > 0` with non-empty
 *   `failures` indicates chunks whose fetch genuinely errored. Painting into a
 *   pinned chunk still works; a failed chunk re-fetches lazily on first read,
 *   which retries and then surfaces a hard read failure rather than a
 *   false-empty baseline. `skipped` counts chunks left unpinned because the
 *   pinned set reached its memory budget (the chunk that met it is resident,
 *   but as an ordinary, evictable chunk); they load on demand like any other
 *   chunk.
 */
export type ChunkLoadProgressState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "loading";
      readonly loaded: number;
      readonly total: number;
      readonly failed: number;
    }
  | {
      readonly kind: "done";
      readonly total: number;
      readonly failed: number;
      readonly failures: readonly ChunkLoadFailure[];
      /** Present only when the memory budget stopped the preload early. */
      readonly skipped?: number;
    };

/** Resolves the neuroglancer volume chunk source for a `(layer, resolution)`. */
export type ResolveVolumeChunkSource = (
  layerId: LayerId,
  resolution: Resolution,
) => VolumeChunkSource;

interface PreloadItem {
  readonly source: VolumeChunkSource;
  readonly key: string;
  readonly gridPosition: Float32Array;
  readonly layerId: LayerId;
  readonly resolution: Resolution;
}

/** What a session's preload runs against. */
export interface SessionChunkPreloadOptions {
  /**
   * Fetches in flight at once, read when the preload starts. In the viewer:
   * `preloadPoolSizeFor` its download limit.
   */
  readonly poolSize: number;
  /** Bytes the pinned set may take, read at every pin. Absent: no limit. */
  readonly pinBudgetBytes?: () => number;
  /**
   * Whether a layer's chunks take the pin budget before the others'. The
   * budget goes in work-list order, so without it, the first layer in the
   * session config could take it all and leave the layer being painted
   * unpinned. Absent: config order.
   */
  readonly pinsFirst?: (layerId: LayerId) => boolean;
}

/**
 * Most fetches in flight at once. A chunk fetch spends most of its time waiting
 * for the store's answer, not transferring, so the preload's throughput grows
 * with the fetches in flight. At the previous 8, a 5072-chunk region took 112 s
 * to load from GCS.
 */
export const PRELOAD_POOL_SIZE = 100;

/**
 * Share of neuroglancer's download slots (`concurrentDownloads`, 100 by
 * default) the preload may hold. Its fetches are requested at the highest
 * priority, so every slot it holds is one the chunks on screen cannot use; at
 * the full limit, the rest of the viewer would wait for the whole region.
 */
const PRELOAD_DOWNLOAD_SHARE = 0.5;

/** The preload's pool size under the viewer's download limit. */
export function preloadPoolSizeFor(download: CapacitySpecification): number {
  return Math.max(
    1,
    Math.min(
      PRELOAD_POOL_SIZE,
      Math.floor(PRELOAD_DOWNLOAD_SHARE * download.itemLimit.value),
    ),
  );
}

/**
 * Share of the smaller of the GPU and system memory limits the pinned set may
 * take. Pinned chunks can never be evicted: once they fill a limit, the chunk
 * queues promote nothing more and the whole viewer stops loading. The rest
 * stays free for the chunks on screen.
 */
const PIN_BUDGET_SHARE = 0.6;

/** The pinned set's budget under the viewer's memory limits. */
export function pinBudgetFor(capacities: {
  readonly gpuMemory: CapacitySpecification;
  readonly systemMemory: CapacitySpecification;
}): number {
  return (
    PIN_BUDGET_SHARE *
    Math.min(
      capacities.gpuMemory.sizeLimit.value,
      capacities.systemMemory.sizeLimit.value,
    )
  );
}

/**
 * Bytes a resident chunk holds, as the chunk queues count them (the byte length
 * of its data). Chunk formats keep their data in a `data` field the frontend
 * `Chunk` type does not declare.
 */
function residentBytes(chunk: unknown): number {
  return (
    (chunk as { data?: ArrayBufferView | null } | undefined)?.data
      ?.byteLength ?? 0
  );
}

/** How often, at most, to publish a progress update while loading. */
const PROGRESS_THROTTLE_MS = 100;

/**
 * Proactively downloads and pins every chunk covering the edit-session bbox.
 *
 * Created once per session by `NgChunkSource.pinChunks`. Loading runs in the
 * background with bounded concurrency via `SliceViewChunkSource.fetchChunk`,
 * which awaits chunk arrival through the existing pipeline (no main-thread
 * block) and lets us mark each chunk permanent while it is resident in system
 * memory — no JS-side byte cloning. Painting is allowed immediately; reads that
 * race the preload simply await their own fetch as before.
 *
 * Pinning stops at the memory budget: the chunk that would exceed it stays an
 * ordinary, evictable chunk, and the fetches still in flight are cancelled.
 */
export class SessionChunkPreloader {
  readonly progress = new WatchableValue<ChunkLoadProgressState>({
    kind: "idle",
  });

  /** Keys of the pinned chunks, per source. */
  private readonly pinned = new Map<VolumeChunkSource, Set<string>>();
  private loaded = 0;
  private failed = 0;
  private total = 0;
  private readonly failures: ChunkLoadFailure[] = [];
  private lastDispatch = 0;
  private released = false;
  private pinnedBytes = 0;
  /**
   * Aborts the fetches in flight: when the session's signal aborts, or once
   * the pinned set reaches its budget.
   */
  private readonly fetchAbort = new AbortController();

  constructor(
    private readonly resolveSource: ResolveVolumeChunkSource,
    private readonly options: SessionChunkPreloadOptions,
  ) {}

  /**
   * Begin preloading `coords` in the background. Does not block — the returned
   * promise resolves when the pool drains, but callers (pinChunks) need not
   * await it. Aborting `signal` stops dispatching new fetches and cancels the
   * ones in flight.
   */
  async start(
    coords: readonly OverlayCoord[],
    signal: AbortSignal,
  ): Promise<void> {
    const items = this.buildWorkList(coords);
    this.total = items.length + this.failed;
    if (this.total === 0) {
      this.finish();
      return;
    }
    const abortFetches = () => this.fetchAbort.abort(signal.reason);
    if (signal.aborted) abortFetches();
    signal.addEventListener("abort", abortFetches, { once: true });
    this.publishLoading(true);
    try {
      await runWithConcurrency(
        items,
        this.options.poolSize,
        () => this.fetchAbort.signal.aborted,
        (item) => this.fetchOne(item),
      );
    } finally {
      signal.removeEventListener("abort", abortFetches);
    }
    if (signal.aborted) return;
    this.finish();
  }

  /**
   * Release every pinned chunk and reset progress. Idempotent. Abort of the
   * in-flight pool is driven by the caller's AbortController.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const [source, keys] of this.pinned) {
      for (const key of keys) {
        source.chunkManager.markChunkPermanent(source, key, false);
      }
    }
    this.pinned.clear();
    this.progress.value = { kind: "idle" };
  }

  /**
   * Resolve sources per group and flatten into a per-chunk work list, the
   * layers that pin first leading. A group whose source cannot be resolved is
   * recorded as failed (non-fatal) and its chunks are skipped — those reads
   * zero-fill lazily if ever painted.
   */
  private buildWorkList(coords: readonly OverlayCoord[]): PreloadItem[] {
    const items: PreloadItem[] = [];
    for (const group of this.groupsInPinOrder(coords)) {
      let source: VolumeChunkSource;
      try {
        source = this.resolveSource(group.layerId, group.resolution);
      } catch {
        this.failed += group.coords.length;
        this.failures.push({
          layerId: group.layerId,
          resolution: group.resolution,
          count: group.coords.length,
        });
        continue;
      }
      for (const coord of group.coords) {
        const chunkCoord: ChunkCoord = ChunkIdFactory.toCoord(coord.chunkId);
        const gridPosition = makeChunkGridPosition(source, chunkCoord);
        const key = chunkKeyForSource(source, chunkCoord);
        items.push({
          source,
          key,
          gridPosition,
          layerId: group.layerId,
          resolution: group.resolution,
        });
      }
    }
    return items;
  }

  /** `coords` grouped by `(layer, resolution)`, the layers that pin first leading. */
  private groupsInPinOrder(coords: readonly OverlayCoord[]) {
    const groups = groupByLayerAndResolution(coords);
    const { pinsFirst } = this.options;
    if (pinsFirst === undefined) return groups;
    return [
      ...groups.filter((group) => pinsFirst(group.layerId)),
      ...groups.filter((group) => !pinsFirst(group.layerId)),
    ];
  }

  private async fetchOne(item: PreloadItem): Promise<void> {
    const { source, key, gridPosition } = item;
    const { signal } = this.fetchAbort;
    let pinned = false;
    try {
      await source.fetchChunk(
        gridPosition,
        (chunk) => {
          // `transform` runs while the chunk is resident in system memory —
          // the correct (and only safe) moment to pin it. No byte cloning:
          // the data stays owned by the chunk manager.
          pinned = this.tryPin(source, key, residentBytes(chunk));
        },
        { signal },
      );
      if (pinned) {
        this.loaded += 1;
      } else if (!this.released) {
        // Past the budget nothing more is pinned: cancel the rest.
        this.fetchAbort.abort();
      }
    } catch {
      if (signal.aborted) return;
      // A sparse / absent chunk does NOT land here — it resolves successfully
      // with null data (the kvStore read returns `undefined` for a 404/403
      // without throwing), so it is counted as `loaded` above. Reaching the
      // catch means a genuine fetch failure (5xx, network/CORS, decode, RPC).
      // Record it as failed rather than masking it as loaded: the chunk was
      // not pinned, and the matching lazy `readBaselineChunk` now retries and
      // then surfaces a hard read failure instead of a false-empty baseline.
      this.failed += 1;
      this.recordFailure(item.layerId, item.resolution);
    }
    this.publishLoading(false);
  }

  /**
   * Pin a resident chunk unless the session has been released or the chunk
   * would take the pinned set past its budget.
   */
  private tryPin(
    source: VolumeChunkSource,
    key: string,
    bytes: number,
  ): boolean {
    // Nothing would unpin a chunk pinned after release.
    if (this.released) return false;
    let keys = this.pinned.get(source);
    if (keys === undefined) {
      keys = new Set();
      this.pinned.set(source, keys);
    }
    // Two session layers on one volume share its chunk source, so the same
    // chunk can come up twice: it is pinned, and its bytes counted, once.
    if (keys.has(key)) return true;
    const budget = this.options.pinBudgetBytes?.() ?? Number.POSITIVE_INFINITY;
    if (this.pinnedBytes + bytes > budget) return false;
    source.chunkManager.markChunkPermanent(source, key, true);
    keys.add(key);
    this.pinnedBytes += bytes;
    return true;
  }

  /** Aggregate a single failed chunk into the per-`(layer, resolution)` tally. */
  private recordFailure(layerId: LayerId, resolution: Resolution): void {
    const existing = this.failures.find(
      (f) => f.layerId === layerId && f.resolution === resolution,
    );
    if (existing !== undefined) {
      this.failures[this.failures.indexOf(existing)] = {
        layerId,
        resolution,
        count: existing.count + 1,
      };
    } else {
      this.failures.push({ layerId, resolution, count: 1 });
    }
  }

  private publishLoading(force: boolean): void {
    if (this.released) return;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!force && now - this.lastDispatch < PROGRESS_THROTTLE_MS) return;
    this.lastDispatch = now;
    this.progress.value = {
      kind: "loading",
      loaded: this.loaded,
      total: this.total,
      failed: this.failed,
    };
  }

  private finish(): void {
    if (this.released) return;
    const skipped = this.total - this.loaded - this.failed;
    this.progress.value = {
      kind: "done",
      total: this.total,
      failed: this.failed,
      failures: this.failures.slice(),
      ...(skipped > 0 ? { skipped } : {}),
    };
  }
}

/**
 * Run `worker` over `items` with at most `limit` concurrent invocations.
 * Resolves once every item has settled (worker never rejects — callers handle
 * their own errors). Stops launching new work once `shouldStop` is true.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  shouldStop: () => boolean,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners: Promise<void>[] = [];
  const launch = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      await worker(item);
    }
  };
  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; ++i) {
    runners.push(launch());
  }
  await Promise.all(runners);
}
