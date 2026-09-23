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
 * @file Combining one chunk's local edits with the remote's, voxel by voxel.
 *
 * The three inputs are the three states a voxel can be in: the BASELINE this
 * session last observed remotely, MINE as painted over it, and REMOTE as it
 * stands now. Which of the two sides changed a voxel is what decides it:
 *
 *   only I changed it        -> mine
 *   only they changed it     -> theirs
 *   both, to the same value  -> that value
 *   both, to different values-> a COLLISION; counted, not resolved here
 *
 * The kernel leaves mine in place for a collision, but that is a detail of
 * how it counts rather than the system's answer: a chunk with any collision
 * is handed to `reloadedOwnedRegion`, which gives its whole owned box back to
 * the remote. So treat `unresolved` as detection, not as a decision.
 *
 * WHY NOT "COMBINE NON-ZEROS". The obvious union — take whichever side is
 * non-zero — cannot represent an ERASE. Erasing is painting zero, so a union
 * silently restores every voxel the user rubbed out if the other side still
 * holds a label there, and the eraser stops working exactly when two people
 * share a region. Three inputs are what make "erased" distinguishable from
 * "never painted": the baseline says which of the two zeroes is a change.
 *
 * WHY BYTES, NOT VALUES. Chunks come in eight voxel types, one of which is
 * 64-bit and indexes as `bigint` while the rest index as `number`. Comparing
 * and copying whole voxels as byte runs makes the kernel identical for all of
 * them — no per-dtype branch, no BigInt, no widening. Segment ids are
 * integers, so bit equality is value equality.
 *
 * Everything is scoped to the OWNED sub-box, the same one the write and the
 * conflict scan use. Voxels outside it belong to a neighbouring task; this
 * save neither writes nor reasons about them.
 */

import type { ChunkOwnedGeometry } from "#src/editing/region/owned_chunk_write.js";

export interface ThreeWayMerge {
  /**
   * Full-chunk bytes: a copy of mine, with the owned sub-box replaced by the
   * merge. Full-chunk because that is what a chunk slot holds; the write path
   * clips to the owned box on the way out.
   */
  readonly merged: Uint8Array;
  /** Voxels the remote changed and we did not — their work, taken in. */
  readonly acceptedFromRemote: number;
  /**
   * Voxels both sides changed, to different values.
   *
   * Non-zero means this chunk cannot be merged: the caller discards `merged`
   * and reloads the owned box from the remote instead (see
   * `owned_region_reload.ts`). The count survives as the finer measure behind
   * that decision — it is what lets the save report how much of the user's
   * work the reload cost, which PRODUCT.md's "never lose the user's input"
   * demands we say out loud when we cannot honour it.
   */
  readonly unresolved: number;
}

/**
 * Merge one chunk's owned sub-box. Inputs are never mutated.
 *
 * All three views must be whole chunks of the same geometry — the same
 * assumption `ownedRegionBytes` makes, and what both the overlay slot and a
 * fresh decoded read provide.
 */
export function mergeOwnedRegion(
  baseline: ArrayBufferView,
  mine: ArrayBufferView,
  remote: ArrayBufferView,
  owned: ChunkOwnedGeometry,
): ThreeWayMerge {
  const baselineBytes = asBytes(baseline);
  const mineBytes = asBytes(mine);
  const remoteBytes = asBytes(remote);
  const merged = new Uint8Array(mineBytes);

  const [chunkSizeX, chunkSizeY, chunkSizeZ] = owned.chunkDataSize;
  const voxelBytes = owned.bytesPerVoxel;
  const rowStrideBytes = chunkSizeX * voxelBytes;
  const sliceStrideBytes = rowStrideBytes * chunkSizeY;
  const channelStrideBytes = sliceStrideBytes * chunkSizeZ;

  const startX = owned.ownedBox.start[0] - owned.chunkBox.start[0];
  const startY = owned.ownedBox.start[1] - owned.chunkBox.start[1];
  const startZ = owned.ownedBox.start[2] - owned.chunkBox.start[2];
  const endX = owned.ownedBox.end[0] - owned.chunkBox.start[0];
  const endY = owned.ownedBox.end[1] - owned.chunkBox.start[1];
  const endZ = owned.ownedBox.end[2] - owned.chunkBox.start[2];

  let acceptedFromRemote = 0;
  let unresolved = 0;

  for (let channel = 0; channel < owned.channels; channel++) {
    const channelOffset = channel * channelStrideBytes;
    for (let z = startZ; z < endZ; z++) {
      const sliceOffset = channelOffset + z * sliceStrideBytes;
      for (let y = startY; y < endY; y++) {
        const rowOffset = sliceOffset + y * rowStrideBytes;
        for (let x = startX; x < endX; x++) {
          const voxelOffset = rowOffset + x * voxelBytes;
          const outcome = resolveVoxel(
            baselineBytes,
            mineBytes,
            remoteBytes,
            voxelOffset,
            voxelBytes,
          );
          if (outcome === "take-remote") {
            merged.set(
              remoteBytes.subarray(voxelOffset, voxelOffset + voxelBytes),
              voxelOffset,
            );
            acceptedFromRemote++;
          } else if (outcome === "unresolved") {
            unresolved++;
          }
        }
      }
    }
  }

  return { merged, acceptedFromRemote, unresolved };
}

type VoxelOutcome = "keep-mine" | "take-remote" | "unresolved";

/**
 * Which side wins one voxel. `keep-mine` covers three cases that need no
 * copy — nobody changed it, only I did, or we agreed — because `merged`
 * already starts as a copy of mine.
 */
function resolveVoxel(
  baseline: Uint8Array,
  mine: Uint8Array,
  remote: Uint8Array,
  offset: number,
  length: number,
): VoxelOutcome {
  const remoteChanged = !bytesEqualAt(baseline, remote, offset, length);
  if (!remoteChanged) return "keep-mine";
  const mineChanged = !bytesEqualAt(baseline, mine, offset, length);
  if (!mineChanged) return "take-remote";
  return bytesEqualAt(mine, remote, offset, length)
    ? "keep-mine"
    : "unresolved";
}

/** Equality of one voxel's bytes, at the same offset in two whole chunks. */
function bytesEqualAt(
  left: Uint8Array,
  right: Uint8Array,
  offset: number,
  length: number,
): boolean {
  for (let index = 0; index < length; index++) {
    if (left[offset + index] !== right[offset + index]) return false;
  }
  return true;
}

function asBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
