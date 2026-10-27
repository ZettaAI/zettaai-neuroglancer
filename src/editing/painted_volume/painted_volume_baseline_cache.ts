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
 * @file Decoded datasource baselines of the chunks being painted.
 *
 * Every stroke delta needs its chunk's baseline, and `readDatasourceBaseline`
 * decodes the whole chunk on every call. The preview keeps the decoded views of
 * recently painted chunks here, bounded by chunk count and bytes (plan §3.12);
 * an evicted chunk is simply read again. Reads run asynchronously: a lookup
 * that misses starts one read and reports `loading`, and `onLoaded` wakes the
 * owner when it lands.
 */

import type { ChunkId, Logger } from "@zettaai/edit-session";

import type { ChunkKey } from "#src/editing/local_patch_source.js";
import type { BaselineVoxelView } from "#src/editing/painted_volume/painted_volume_occupancy.js";

/** Reads one decoded datasource chunk of the preview's layer and resolution. */
export type PaintedVolumeBaselineReader = (
  chunkId: ChunkId,
  signal: AbortSignal,
) => Promise<BaselineVoxelView>;

export type BaselineLookup =
  | { readonly kind: "ready"; readonly view: BaselineVoxelView }
  | { readonly kind: "loading" }
  /** The last read failed; reported once, the next lookup reads again. */
  | { readonly kind: "failed" };

export interface BaselineCacheLimits {
  readonly maxChunks: number;
  readonly maxBytes: number;
}

/** Plan §3.12: a 128×128×64 uint32 chunk is ~4 MiB, so ~32 fit the bytes. */
export const DEFAULT_BASELINE_CACHE_LIMITS: BaselineCacheLimits = {
  maxChunks: 16,
  maxBytes: 128 * 1024 * 1024,
};

export class PaintedVolumeBaselineCache {
  /** Map order is recency: the first entry is the least recently used. */
  private readonly viewByKey = new Map<ChunkKey, BaselineVoxelView>();
  private readonly readByKey = new Map<ChunkKey, AbortController>();
  private readonly failedKeys = new Set<ChunkKey>();
  private cachedBytes = 0;

  constructor(
    private readonly read: PaintedVolumeBaselineReader,
    private readonly onLoaded: () => void,
    private readonly logger: Logger,
    private readonly limits: BaselineCacheLimits = DEFAULT_BASELINE_CACHE_LIMITS,
  ) {}

  lookup(key: ChunkKey, chunkId: ChunkId): BaselineLookup {
    const view = this.viewByKey.get(key);
    if (view !== undefined) {
      this.viewByKey.delete(key);
      this.viewByKey.set(key, view);
      return { kind: "ready", view };
    }
    if (this.failedKeys.delete(key)) return { kind: "failed" };
    if (!this.readByKey.has(key)) this.startRead(key, chunkId);
    return { kind: "loading" };
  }

  /** Forget `key`, aborting its read if one is in flight. */
  evict(key: ChunkKey): void {
    this.readByKey.get(key)?.abort();
    this.readByKey.delete(key);
    this.failedKeys.delete(key);
    this.dropView(key);
  }

  /** Forget everything, aborting every read in flight. */
  clear(): void {
    for (const controller of this.readByKey.values()) controller.abort();
    this.readByKey.clear();
    this.failedKeys.clear();
    this.viewByKey.clear();
    this.cachedBytes = 0;
  }

  private startRead(key: ChunkKey, chunkId: ChunkId): void {
    const controller = new AbortController();
    this.readByKey.set(key, controller);
    this.read(chunkId, controller.signal).then(
      (view) => {
        if (!this.finishRead(key, controller)) return;
        this.store(key, view);
        this.onLoaded();
      },
      (error: unknown) => {
        if (!this.finishRead(key, controller)) return;
        this.logger.warn(
          "session",
          `3D preview: baseline read failed for chunk ${key}`,
          error,
        );
        this.failedKeys.add(key);
        this.onLoaded();
      },
    );
  }

  /** `false` when the read was evicted or cleared while in flight. */
  private finishRead(key: ChunkKey, controller: AbortController): boolean {
    if (controller.signal.aborted || this.readByKey.get(key) !== controller) {
      return false;
    }
    this.readByKey.delete(key);
    return true;
  }

  private store(key: ChunkKey, view: BaselineVoxelView): void {
    this.viewByKey.set(key, view);
    this.cachedBytes += view.byteLength;
    for (const oldestKey of this.viewByKey.keys()) {
      const withinLimits =
        this.viewByKey.size <= this.limits.maxChunks &&
        this.cachedBytes <= this.limits.maxBytes;
      if (withinLimits || oldestKey === key) break;
      this.dropView(oldestKey);
    }
  }

  private dropView(key: ChunkKey): void {
    const view = this.viewByKey.get(key);
    if (view === undefined) return;
    this.viewByKey.delete(key);
    this.cachedBytes -= view.byteLength;
  }
}
