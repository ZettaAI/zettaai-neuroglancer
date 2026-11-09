/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import {
  boxVoxelCount,
  readCompressedSegmentationBox,
} from "#src/editing/adapters/compressed_segmentation_box_read.js";
import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import { decodeChannels } from "#src/sliceview/compressed_segmentation/decode_common.js";
import { encodeChannels as encodeChannelsUint32 } from "#src/sliceview/compressed_segmentation/encode_uint32.js";
import { encodeChannels as encodeChannelsUint64 } from "#src/sliceview/compressed_segmentation/encode_uint64.js";
import { TypedArrayBuilder } from "#src/util/array.js";

type Size = readonly [number, number, number];

/** Deterministic pseudo-random ids from a small alphabet (several bits). */
function randomIds(size: Size, alphabet: number, seed: number): number[] {
  let state = seed;
  const ids: number[] = [];
  for (let i = 0; i < size[0] * size[1] * size[2]; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    ids.push((state >>> 8) % alphabet);
  }
  return ids;
}

function encodeUint64(ids: number[], size: Size, blockSize: Size): Uint32Array {
  const output = new TypedArrayBuilder(Uint32Array);
  // High word set too, so a dropped high word shows.
  const values = BigUint64Array.from(ids, (id) => BigInt(id) * 0x100000001n);
  encodeChannelsUint64(output, blockSize, values, [...size, 1]);
  return output.view.slice();
}

function encodeUint32(ids: number[], size: Size, blockSize: Size): Uint32Array {
  const output = new TypedArrayBuilder(Uint32Array);
  encodeChannelsUint32(output, blockSize, Uint32Array.from(ids), [...size, 1]);
  return output.view.slice();
}

/**
 * The reference: decode the whole chunk upstream, then cut the box out,
 * reading 0 outside the clipped extent (the padding of an edge chunk).
 */
function decodeThenCrop<T extends Uint32Array | BigUint64Array>(
  data: Uint32Array,
  clipped: Size,
  blockSize: Size,
  box: ChunkVoxelBox,
  make: (length: number) => T,
): T {
  const full = decodeChannels(
    make(clipped[0] * clipped[1] * clipped[2]),
    data,
    0,
    [...clipped, 1],
    blockSize,
  );
  const out = make(boxVoxelCount(box));
  let outIndex = 0;
  for (let z = box.z0; z <= box.z1; z++) {
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++, outIndex++) {
        if (x >= clipped[0] || y >= clipped[1] || z >= clipped[2]) continue;
        out[outIndex] = full[(z * clipped[1] + y) * clipped[0] + x];
      }
    }
  }
  return out;
}

const uint64Of = (length: number) => new BigUint64Array(length);
const uint32Of = (length: number) => new Uint32Array(length);

function boxRead<T extends Uint32Array | BigUint64Array>(
  data: Uint32Array,
  clipped: Size,
  blockSize: Size,
  box: ChunkVoxelBox,
  make: (length: number) => T,
): T {
  const out = make(boxVoxelCount(box));
  readCompressedSegmentationBox(data, clipped, blockSize, box, out);
  return out;
}

interface Case {
  readonly label: string;
  readonly clipped: Size;
  readonly blockSize: Size;
  readonly box: ChunkVoxelBox;
}

const CASES: readonly Case[] = [
  {
    // NG's transcode block for a z=1 chunk; the box crosses block edges on
    // both axes.
    label: "16×32×1 blocks, box across block boundaries",
    clipped: [96, 80, 1],
    blockSize: [16, 32, 1],
    box: { x0: 10, y0: 25, z0: 0, x1: 40, y1: 70, z1: 0 },
  },
  {
    label: "8×8×8 blocks, 3D box across blocks",
    clipped: [24, 20, 18],
    blockSize: [8, 8, 8],
    box: { x0: 5, y0: 3, z0: 6, x1: 17, y1: 12, z1: 16 },
  },
  {
    // An edge chunk: blocks are laid out for 37×29, not for the nominal size,
    // and the last blocks are partial.
    label: "edge chunk with partial last blocks",
    clipped: [37, 29, 1],
    blockSize: [16, 32, 1],
    box: { x0: 30, y0: 20, z0: 0, x1: 36, y1: 28, z1: 0 },
  },
  {
    // Part of the box beyond the clipped extent reads 0.
    label: "box past the clipped extent",
    clipped: [37, 29, 1],
    blockSize: [16, 32, 1],
    box: { x0: 30, y0: 20, z0: 0, x1: 60, y1: 50, z1: 0 },
  },
  {
    label: "box entirely past the clipped extent",
    clipped: [37, 29, 1],
    blockSize: [16, 32, 1],
    box: { x0: 40, y0: 0, z0: 0, x1: 50, y1: 5, z1: 0 },
  },
  {
    label: "the whole chunk",
    clipped: [48, 40, 2],
    blockSize: [16, 32, 1],
    box: { x0: 0, y0: 0, z0: 0, x1: 47, y1: 39, z1: 1 },
  },
];

describe("readCompressedSegmentationBox", () => {
  for (const { label, clipped, blockSize, box } of CASES) {
    it(`uint64, ${label}: same values as a full decode, cropped`, () => {
      const data = encodeUint64(randomIds(clipped, 13, 7), clipped, blockSize);
      expect(boxRead(data, clipped, blockSize, box, uint64Of)).toEqual(
        decodeThenCrop(data, clipped, blockSize, box, uint64Of),
      );
    });

    it(`uint32, ${label}: same values as a full decode, cropped`, () => {
      const data = encodeUint32(randomIds(clipped, 13, 11), clipped, blockSize);
      expect(boxRead(data, clipped, blockSize, box, uint32Of)).toEqual(
        decodeThenCrop(data, clipped, blockSize, box, uint32Of),
      );
    });
  }

  it("reads a block with encodingBits = 0 (one value for the whole block)", () => {
    const clipped: Size = [32, 32, 1];
    const blockSize: Size = [16, 32, 1];
    // Left block constant (encoded with 0 bits), right block varied.
    const ids = randomIds(clipped, 5, 3).map((id, i) =>
      i % 32 < 16 ? 42 : id,
    );
    const data = encodeUint64(ids, clipped, blockSize);
    const box: ChunkVoxelBox = { x0: 4, y0: 2, z0: 0, x1: 24, y1: 30, z1: 0 };
    const read = boxRead(data, clipped, blockSize, box, uint64Of);
    expect(read).toEqual(
      decodeThenCrop(data, clipped, blockSize, box, uint64Of),
    );
    expect(read[0]).toBe(42n * 0x100000001n);
  });

  it("leaves voxels past the clipped extent as they are in the output", () => {
    const clipped: Size = [4, 4, 1];
    const data = encodeUint32(randomIds(clipped, 3, 1), clipped, [4, 4, 1]);
    const box: ChunkVoxelBox = { x0: 3, y0: 0, z0: 0, x1: 5, y1: 0, z1: 0 };
    const out = Uint32Array.from([9, 9, 9]);
    readCompressedSegmentationBox(data, clipped, [4, 4, 1], box, out);
    expect(Array.from(out.subarray(1))).toEqual([9, 9]);
  });

  it("refuses an output of the wrong size", () => {
    const clipped: Size = [4, 4, 1];
    const data = encodeUint32(randomIds(clipped, 3, 1), clipped, [4, 4, 1]);
    const box: ChunkVoxelBox = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 0 };
    expect(() =>
      readCompressedSegmentationBox(
        data,
        clipped,
        [4, 4, 1],
        box,
        new Uint32Array(3),
      ),
    ).toThrow(/output length 3 != box voxel count 4/);
  });
});
