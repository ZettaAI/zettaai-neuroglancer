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
 * @file Giving one chunk back to the remote: Take theirs, wholesale.
 *
 * This is no longer what a collision costs. `mergeOwnedRegion` resolves a
 * colliding voxel to the remote by itself, so Combine keeps every local edit
 * outside the voxels actually shared — handing the whole owned box back for
 * one colliding voxel discarded a whole chunk's painting and meant two
 * tracers in one region could not both keep their strokes.
 *
 * What remains is the USER'S explicit answer: Take theirs on the conflict
 * dialog, and the discard-on-exit path. Both are a deliberate "drop what I
 * did here", which is why they are allowed to be blunt. The other reason this
 * survives is that it needs no baseline, so it is the only answer available
 * for a chunk the scan could not prove.
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

import type { ChunkOwnedGeometry } from "#src/editing/region/owned_chunk_write.js";

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
