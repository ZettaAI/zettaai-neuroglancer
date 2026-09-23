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
 * @file Giving one chunk back to the remote: the answer for a chunk both
 * sides changed in the same place.
 *
 * `mergeOwnedRegion` combines two edits voxel by voxel and can resolve every
 * voxel except one case — both sides changed it, to different values. This is
 * what happens to a chunk that contains any of those: the whole owned sub-box
 * reverts to what storage holds, and the local edits in it are dropped.
 *
 * WHY THE WHOLE BOX, FOR ONE COLLIDING VOXEL. Segmentation is topological,
 * not per-voxel. Mixing two traces voxel by voxel can produce an object
 * neither annotator drew — a process spliced from two centrelines, or a label
 * leaking through a membrane one of them drew and the other did not. Taking
 * one side wholesale guarantees the section stays a thing somebody actually
 * traced. It is a deliberately blunt rule and it costs more than it has to:
 * at `chunk_size = [1024, 1024, 1]` a chunk is one z-slice, so a single
 * colliding voxel can discard a whole section's work. Whoever changes this
 * rule should change it here, and should know that is the trade.
 *
 * WHY NOT THE WHOLE CHUNK. "Reload the chunk from storage" taken literally
 * would also revert the bytes outside the owned box — and those belong to a
 * neighbouring task, which by construction is the only reason the two tasks
 * share a chunk at all. Every other operation on this path is owned-box
 * scoped; so is this one.
 *
 * WHY A FULL-CHUNK BUFFER COMES BACK. A chunk slot holds a whole chunk, and
 * `commitWrites` publishes only the subregion it is given — but the slot
 * keeps whatever was written outside it. Returning mine-with-the-box-replaced
 * means the bytes left in the slot outside the owned box are still mine, so a
 * later unrelated stroke committing a different subregion cannot publish
 * foreign bytes that were staged here.
 */

import type { ThreeWayMerge } from "#src/editing/reconcile/three_way_merge.js";
import type { ChunkOwnedGeometry } from "#src/editing/region/owned_chunk_write.js";

/**
 * Whether a merged chunk has to be given back to the remote instead.
 *
 * The rule in one line: ANY colliding voxel reloads the whole owned box. The
 * merge already found them, so this is a read of its result rather than a
 * second pass.
 */
export function mustReloadFromRemote(merge: ThreeWayMerge): boolean {
  return merge.unresolved > 0;
}

/**
 * One chunk's owned sub-box, taken from the remote. Inputs are never mutated.
 *
 * All views must be whole chunks of the same geometry — the same assumption
 * `mergeOwnedRegion` and `ownedRegionBytes` make.
 *
 * Unlike the merge this needs no baseline and makes no per-voxel decision:
 * the owned box is replaced wholesale, so it copies a contiguous run per row
 * rather than walking voxels.
 */
export function reloadedOwnedRegion(
  mine: ArrayBufferView,
  remote: ArrayBufferView,
  owned: ChunkOwnedGeometry,
): Uint8Array {
  const reloaded = new Uint8Array(asBytes(mine));
  const remoteBytes = asBytes(remote);

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

  // The owned box is contiguous along x, so one row of it is one byte run.
  const runBytes = (endX - startX) * voxelBytes;
  const runStartBytes = startX * voxelBytes;

  for (let channel = 0; channel < owned.channels; channel++) {
    const channelOffset = channel * channelStrideBytes;
    for (let z = startZ; z < endZ; z++) {
      const sliceOffset = channelOffset + z * sliceStrideBytes;
      for (let y = startY; y < endY; y++) {
        const runOffset = sliceOffset + y * rowStrideBytes + runStartBytes;
        reloaded.set(
          remoteBytes.subarray(runOffset, runOffset + runBytes),
          runOffset,
        );
      }
    }
  }

  return reloaded;
}

function asBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
