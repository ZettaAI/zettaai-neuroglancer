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
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";

import type { SessionBaselineReader } from "#src/editing/overlay/patch_mirror.js";

/** Where this session's own copy of a chunk can be, most recent first. */
export interface SessionEditBaselineSources {
  /** Bytes committed to the host store by an earlier session on this page. */
  committed(coord: OverlayCoord): ReadonlyChunkVoxelBuffer | undefined;
  /** Bytes this session saved, while the bounded store still holds them. */
  saved(coord: OverlayCoord): ReadonlyChunkVoxelBuffer | undefined;
  /** The snapshot the library took when the session opened. */
  sessionOpen(
    coord: OverlayCoord,
  ): Promise<ReadonlyChunkVoxelBuffer> | undefined;
}

/**
 * This session's own baseline, for `PatchMirror.resyncAfterRefetch` only.
 *
 * Deliberately not `readBaselineChunk`: that one falls through to the
 * datasource when it has no saved or committed copy, and the datasource is
 * precisely what a refetch is replacing — so for a chunk painted but never
 * saved it would hand back the colleague's incoming bytes and the mask would
 * mark everything they moved. The chain ends at the session-open snapshot and
 * returns undefined rather than guessing.
 *
 * A saved chunk the store has evicted (TM-373) falls back to the session-open
 * snapshot, so its saved voxels count as this session's edits again and the
 * patch keeps drawing them. The screen stays right; the cost is that a
 * colleague's later change to those voxels is hidden until the next session.
 */
export function sessionEditBaselineReader(
  sources: SessionEditBaselineSources,
): SessionBaselineReader {
  return async (coord) =>
    sources.committed(coord) ??
    sources.saved(coord) ??
    (await sources.sessionOpen(coord));
}
