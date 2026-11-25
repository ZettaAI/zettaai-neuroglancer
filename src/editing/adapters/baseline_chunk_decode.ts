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
 * Decoding a fetched compressed-segmentation chunk into the dense, edit-sized
 * baseline the edit library reads (TM-353, TM-373).
 *
 * Pure and free of Neuroglancer chunk objects, so the same code runs on the
 * main thread and in the baseline decode worker
 * (`baseline_decode_worker_handler.ts`): on a 4096² uint64 chunk the decode is
 * ~360–400 ms, the largest main-thread part of a chunk's first touch that the
 * host owns.
 */

import { decodeChannels } from "#src/sliceview/compressed_segmentation/decode_common.js";

/** Segmentation types Neuroglancer transcodes to compressed segmentation. */
export type CompressedBaselineDataType = "uint32" | "uint64";

/** A typed array of any baseline element type, with its own constructor. */
type DenseVoxels = ArrayLike<unknown> & {
  readonly length: number;
  set(source: ArrayLike<unknown>, offset?: number): void;
  subarray(begin: number, end: number): DenseVoxels;
};

/**
 * Everything needed to decode one chunk away from its `Chunk`: a copy of the
 * compressed block (safe to transfer), its element type and block size, the
 * chunk's edge-clipped extent and the edit-session chunk extent to pad to.
 */
export interface CompressedBaselineChunk {
  readonly compressed: Uint32Array;
  readonly dataType: CompressedBaselineDataType;
  readonly blockSize: readonly [number, number, number];
  readonly clippedSize: readonly [number, number, number];
  readonly editSize: readonly [number, number, number];
}

/**
 * Decode `chunk` at its clipped extent (NG encodes a boundary chunk's block
 * for the clipped data only — decoding with nominal dims runs off the end of
 * the block, TM-353), then pad it to the edit-session extent.
 */
export function decodeCompressedBaseline(
  chunk: CompressedBaselineChunk,
): Uint32Array | BigUint64Array {
  const [clippedX, clippedY, clippedZ] = chunk.clippedSize;
  const voxelCount = clippedX * clippedY * clippedZ;
  const decoded =
    chunk.dataType === "uint64"
      ? new BigUint64Array(voxelCount)
      : new Uint32Array(voxelCount);
  // `decodeChannels` reads the channel count from `chunkDataSize[3]`;
  // segmentation is single-channel.
  decodeChannels(
    decoded,
    chunk.compressed,
    0,
    [clippedX, clippedY, clippedZ, 1],
    chunk.blockSize,
  );
  return padToEditSize(decoded, chunk.clippedSize, chunk.editSize);
}

/**
 * Pad a buffer decoded at `clippedSize` into one of `editSize`, the clipped
 * data in the low corner and the rest zero. Returns `decoded` itself when it
 * already fills `editSize` (every interior chunk).
 */
export function padToEditSize<T extends DenseVoxels>(
  decoded: T,
  clippedSize: readonly [number, number, number],
  editSize: readonly [number, number, number],
): T {
  const [clippedX, clippedY, clippedZ] = clippedSize;
  const [editX, editY, editZ] = editSize;
  if (clippedX === editX && clippedY === editY && clippedZ === editZ) {
    return decoded;
  }
  const ElementArray = decoded.constructor as new (length: number) => T;
  const padded = new ElementArray(editX * editY * editZ);
  for (let z = 0; z < clippedZ; ++z) {
    for (let y = 0; y < clippedY; ++y) {
      const clippedRowStart = (z * clippedY + y) * clippedX;
      const editRowStart = (z * editY + y) * editX;
      padded.set(
        decoded.subarray(clippedRowStart, clippedRowStart + clippedX),
        editRowStart,
      );
    }
  }
  return padded;
}
