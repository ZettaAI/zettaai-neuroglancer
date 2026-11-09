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
 * Read one box of a compressed-segmentation chunk without decoding the rest
 * (TM-373, PR 2).
 *
 * NG transcodes uint32/uint64 segmentation to compressed segmentation, and the
 * patch mirror used to decode the whole chunk on every brush move (~370 ms on
 * a 4096² uint64 chunk) to diff a brush-sized box. This reads the box only,
 * through the upstream per-voxel locator `decodeValueOffset`; the upstream
 * decoder is not changed. Upstream `decodeChannels` walks every voxel through
 * the same locator, so reading a box is never slower than decoding the chunk,
 * whatever the box size.
 */

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import { decodeValueOffset } from "#src/sliceview/compressed_segmentation/decode_common.js";

/** Voxels per axis of an inclusive chunk-local box. */
export function boxSize(box: ChunkVoxelBox): [number, number, number] {
  return [box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, box.z1 - box.z0 + 1];
}

export function boxVoxelCount(box: ChunkVoxelBox): number {
  const [sizeX, sizeY, sizeZ] = boxSize(box);
  return sizeX * sizeY * sizeZ;
}

/**
 * Write the voxels of `box` (chunk-local, inclusive) from single-channel
 * compressed segmentation `data` into `out`, a dense buffer of the box's size
 * in x-fastest order. Voxels outside `clippedSize` are left as they are in
 * `out` (zero for a fresh buffer), as the zero padding of an edge chunk.
 *
 * `clippedSize` must be the chunk's edge-clipped extent: NG encodes an edge
 * chunk's blocks for the clipped data, and the nominal size would give a wrong
 * block grid and read past the end of `data` (TM-353). `blockSize` must be the
 * source's `compressedSegmentationBlockSize`, never an assumed 8×8×8: for a
 * transcoded z=1 chunk NG picks something like 16×32×1.
 */
export function readCompressedSegmentationBox(
  data: Uint32Array,
  clippedSize: readonly [number, number, number],
  blockSize: ArrayLike<number>,
  box: ChunkVoxelBox,
  out: Uint32Array | BigUint64Array,
): void {
  const [boxSizeX, boxSizeY] = boxSize(box);
  if (out.length !== boxVoxelCount(box)) {
    throw new Error(
      `readCompressedSegmentationBox: output length ${out.length} != box ` +
        `voxel count ${boxVoxelCount(box)}`,
    );
  }
  const [clippedX, clippedY, clippedZ] = clippedSize;
  const lastX = Math.min(box.x1, clippedX - 1);
  const lastY = Math.min(box.y1, clippedY - 1);
  const lastZ = Math.min(box.z1, clippedZ - 1);
  // `decodeChannels` layout: a channel-offset header, then the channel.
  const channelOffset = data[0];
  const uint32sPerElement = out instanceof BigUint64Array ? 2 : 1;
  const outWords = new Uint32Array(
    out.buffer,
    out.byteOffset,
    out.length * uint32sPerElement,
  );
  copyBoxValues(
    data,
    channelOffset,
    clippedSize,
    blockSize,
    uint32sPerElement,
    { x0: box.x0, y0: box.y0, z0: box.z0, x1: lastX, y1: lastY, z1: lastZ },
    box,
    boxSizeX,
    boxSizeY,
    outWords,
  );
}

/**
 * Hot path (every brush move on a compressed-segmentation chunk): one
 * `decodeValueOffset` per voxel and a 1–2 word copy, no allocation and no
 * BigInt — a box of a few thousand voxels costs tens of microseconds.
 */
function copyBoxValues(
  data: Uint32Array,
  channelOffset: number,
  clippedSize: readonly [number, number, number],
  blockSize: ArrayLike<number>,
  uint32sPerElement: number,
  readable: ChunkVoxelBox,
  box: ChunkVoxelBox,
  boxSizeX: number,
  boxSizeY: number,
  outWords: Uint32Array,
): void {
  const position = [0, 0, 0];
  for (let z = readable.z0; z <= readable.z1; z++) {
    position[2] = z;
    for (let y = readable.y0; y <= readable.y1; y++) {
      position[1] = y;
      let outIndex =
        ((z - box.z0) * boxSizeY + (y - box.y0)) * boxSizeX +
        (readable.x0 - box.x0);
      for (let x = readable.x0; x <= readable.x1; x++, outIndex++) {
        position[0] = x;
        const valueOffset =
          channelOffset +
          decodeValueOffset(
            data,
            channelOffset,
            clippedSize,
            blockSize,
            position,
            uint32sPerElement,
          );
        const outWord = outIndex * uint32sPerElement;
        outWords[outWord] = data[valueOffset];
        if (uint32sPerElement === 2) {
          outWords[outWord + 1] = data[valueOffset + 1];
        }
      }
    }
  }
}
