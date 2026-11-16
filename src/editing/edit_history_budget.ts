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
 * Undo-history budget for an edit session, sized to its chunks (TM-373).
 *
 * The library's default budget is 256 MB. A history entry holds a full copy of
 * every chunk it touched (before, plus after for image redo), so on 4096² uint64
 * chunks (128 MB each) one masked stroke fills the default budget and undo is a
 * single step. Here the budget grows with the session's largest chunk, within
 * a ceiling.
 *
 * Temporary: once history stores per-box deltas instead of chunk copies, the
 * default budget is enough again.
 */

import type {
  HistoryPolicy,
  LayerMetadata,
  Resolution,
} from "@zettaai/edit-session";
import {
  bytesPerVoxel,
  DEFAULT_HISTORY_POLICY,
  scaleFor,
} from "@zettaai/edit-session";

const MiB = 1024 * 1024;

/**
 * The budget holds this many of the session's largest chunks. At 4 a fill of
 * one tile with image redo (before + after = 2 chunks) fits in the fill's half
 * of the budget (see {@link maxFillHistoryBytes}).
 */
export const HISTORY_BUDGET_CHUNKS = 4;
/** Never below the library default: small chunks keep today's behaviour. */
export const MIN_HISTORY_BUDGET_BYTES = 256 * MiB;
/**
 * Every undo step on large chunks is real memory (~128 MB per 4096² uint64
 * chunk), so the budget stops here rather than growing with the chunk.
 */
export const MAX_HISTORY_BUDGET_BYTES = 768 * MiB;

/** Bytes one chunk of `metadata` at `resolution` takes in a history entry. */
export function bytesPerChunk(
  metadata: LayerMetadata,
  resolution: Resolution,
): number {
  const [x, y, z] = scaleFor(metadata, resolution).chunkDataSize;
  return x * y * z * bytesPerVoxel(metadata.voxelDataType) * metadata.channels;
}

/** One layer the session can write, with the resolutions it opened. */
export interface WritableLayerChunks {
  readonly metadata: LayerMetadata;
  readonly resolutions: readonly Resolution[];
}

/**
 * Content budget for the session's history:
 * `clamp(HISTORY_BUDGET_CHUNKS × largest chunk, 256 MB, 768 MB)`, the largest
 * chunk taken over every writable layer and resolution.
 */
export function historyBudgetBytes(
  layers: readonly WritableLayerChunks[],
): number {
  let largest = 0;
  for (const { metadata, resolutions } of layers) {
    for (const resolution of resolutions) {
      largest = Math.max(largest, bytesPerChunk(metadata, resolution));
    }
  }
  return Math.min(
    MAX_HISTORY_BUDGET_BYTES,
    Math.max(MIN_HISTORY_BUDGET_BYTES, HISTORY_BUDGET_CHUNKS * largest),
  );
}

/** The library's default policy with the content budget sized to the chunks. */
export function editHistoryPolicy(
  layers: readonly WritableLayerChunks[],
): HistoryPolicy {
  return {
    ...DEFAULT_HISTORY_POLICY,
    maxContentBytes: historyBudgetBytes(layers),
  };
}

/**
 * One fill may take at most half of the history budget. Beyond it
 * `drop-oldest` would evict the user's earlier strokes to make room.
 */
export function maxFillHistoryBytes(policy: HistoryPolicy): number {
  return policy.maxContentBytes / 2;
}
