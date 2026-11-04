/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ReadonlyChunkVoxelBuffer } from "@zettaai/edit-session";

const MiB = 1024 * 1024;

/** Bounds on what the store holds. Both apply; the older entries go first. */
export interface SavedBaselineLimits {
  readonly maxChunks: number;
  readonly maxBytes: number;
}

export const DEFAULT_SAVED_BASELINE_LIMITS: SavedBaselineLimits = {
  maxChunks: 512,
  maxBytes: 512 * MiB,
};

/**
 * The bytes this session saved, per chunk (TM-352): what `readBaselineChunk`
 * and the edit-baseline reader return for a saved chunk instead of the
 * datasource, and what a retry re-sends.
 *
 * **The buffer is shared, not copied (TM-373).** It is the one the library
 * captured for the chunk's content ref (`collectDirtyChunks` →
 * `ensureContentRef(slot).retain()`), the same buffer as the `afterRef` of the
 * chunk's last history entry. On a 4096² uint64 chunk a copy here was +128 MB
 * per saved chunk. Nobody may mutate it: not the store, not a reader, not "the
 * save's own copy" — there is none. A caller that needs to write copies at the
 * point of the write (the library already copies a baseline into its working
 * buffer when it materializes a chunk).
 *
 * Bounded by bytes and by chunks, FIFO; a re-save moves a chunk to the back.
 * While history holds the same buffers the store costs only references, but
 * once history drops them only the store keeps them alive, so the byte bound
 * is real memory. The newest entry is never evicted, even alone over the
 * bound. An evicted chunk falls back as described on its readers: baseline
 * reads go to the datasource, the edit baseline to the session-open snapshot.
 *
 * Session-lifetime: the host clears it on teardown.
 */
export class SavedBaselineStore {
  private readonly entries = new Map<string, ReadonlyChunkVoxelBuffer>();
  private retainedBytes = 0;

  constructor(
    private readonly limits: SavedBaselineLimits = DEFAULT_SAVED_BASELINE_LIMITS,
  ) {}

  set(key: string, bytes: ReadonlyChunkVoxelBuffer): void {
    this.delete(key); // a re-save moves the chunk to the back
    this.entries.set(key, bytes);
    this.retainedBytes += bytes.byteLength;
    this.evictOverLimits();
  }

  get(key: string): ReadonlyChunkVoxelBuffer | undefined {
    return this.entries.get(key);
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  /** Bytes the store keeps reachable (some shared with history). */
  get byteLength(): number {
    return this.retainedBytes;
  }

  private delete(key: string): void {
    const existing = this.entries.get(key);
    if (existing === undefined) return;
    this.entries.delete(key);
    this.retainedBytes -= existing.byteLength;
  }

  private evictOverLimits(): void {
    while (
      this.entries.size > 1 &&
      (this.entries.size > this.limits.maxChunks ||
        this.retainedBytes > this.limits.maxBytes)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.delete(oldest);
    }
  }
}
