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

import { mergeOwnedRegion } from "#src/editing/reconcile/three_way_merge.js";
import type { ChunkOwnedGeometry } from "#src/editing/region/owned_chunk_write.js";

/** X-fastest, channel-slowest: index = channel*sx*sy*sz + z*sx*sy + y*sx + x. */
const CHUNK_SIZE: readonly [number, number, number] = [4, 3, 2];
const VOXELS_PER_CHANNEL = CHUNK_SIZE[0] * CHUNK_SIZE[1] * CHUNK_SIZE[2];

function voxelIndex(x: number, y: number, z: number, channel = 0): number {
  const [sizeX, sizeY] = CHUNK_SIZE;
  return channel * VOXELS_PER_CHANNEL + z * sizeX * sizeY + y * sizeX + x;
}

/** Owns x in [0,2) — a chunk shared with a neighbouring task. */
function halfOwned(overrides: Partial<ChunkOwnedGeometry> = {}) {
  return {
    chunkDataSize: CHUNK_SIZE,
    bytesPerVoxel: 1,
    channels: 1,
    chunkBox: { start: [0, 0, 0], end: [4, 3, 2] },
    ownedBox: { start: [0, 0, 0], end: [2, 3, 2] },
    coversWholeChunk: false,
    ...overrides,
  } as ChunkOwnedGeometry;
}

function u8(fill = 0): Uint8Array {
  return new Uint8Array(VOXELS_PER_CHANNEL).fill(fill);
}

describe("mergeOwnedRegion", () => {
  it("takes the remote's voxel where only they changed it", () => {
    const baseline = u8(1);
    const mine = u8(1);
    const remote = u8(1);
    remote[voxelIndex(1, 0, 0)] = 7;

    const result = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(result.merged[voxelIndex(1, 0, 0)]).toBe(7);
    expect(result.acceptedFromRemote).toBe(1);
    expect(result.unresolved).toBe(0);
  });

  it("keeps my voxel where only I changed it", () => {
    const baseline = u8(1);
    const mine = u8(1);
    mine[voxelIndex(0, 0, 0)] = 9;
    const remote = u8(1);

    const result = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(result.merged[voxelIndex(0, 0, 0)]).toBe(9);
    expect(result.acceptedFromRemote).toBe(0);
    expect(result.unresolved).toBe(0);
  });

  it("combines edits from both sides in one pass", () => {
    const baseline = u8(1);
    const mine = u8(1);
    mine[voxelIndex(0, 0, 0)] = 9;
    const remote = u8(1);
    remote[voxelIndex(1, 2, 1)] = 7;

    const result = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(result.merged[voxelIndex(0, 0, 0)]).toBe(9);
    expect(result.merged[voxelIndex(1, 2, 1)]).toBe(7);
    expect(result.unresolved).toBe(0);
  });

  /**
   * The case a non-zero union gets wrong. Erasing is painting zero, so a
   * union would see the remote's surviving label and restore it — the
   * eraser silently stops working wherever two people share a region.
   */
  it("preserves an erase instead of resurrecting the remote's label", () => {
    const baseline = u8(5); // both sides start with a label here
    const mine = u8(5);
    mine[voxelIndex(0, 0, 0)] = 0; // the user erased this voxel
    const remote = u8(5); // nobody else touched it

    const result = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(result.merged[voxelIndex(0, 0, 0)]).toBe(0);
    expect(result.unresolved).toBe(0);
  });

  it("accepts the remote's erase where we did not touch the voxel", () => {
    const baseline = u8(5);
    const mine = u8(5);
    const remote = u8(5);
    remote[voxelIndex(1, 1, 0)] = 0;

    const result = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(result.merged[voxelIndex(1, 1, 0)]).toBe(0);
    expect(result.acceptedFromRemote).toBe(1);
  });

  it("keeps mine and counts the voxel when both sides disagree", () => {
    const baseline = u8(1);
    const mine = u8(1);
    mine[voxelIndex(0, 0, 0)] = 9;
    const remote = u8(1);
    remote[voxelIndex(0, 0, 0)] = 7;

    const result = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(result.merged[voxelIndex(0, 0, 0)]).toBe(9);
    expect(result.unresolved).toBe(1);
    expect(result.acceptedFromRemote).toBe(0);
  });

  it("is not a conflict when both sides made the same edit", () => {
    const baseline = u8(1);
    const mine = u8(1);
    mine[voxelIndex(0, 0, 0)] = 9;
    const remote = u8(1);
    remote[voxelIndex(0, 0, 0)] = 9;

    const result = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(result.merged[voxelIndex(0, 0, 0)]).toBe(9);
    expect(result.unresolved).toBe(0);
    expect(result.acceptedFromRemote).toBe(0);
  });

  it("leaves the neighbour's half of the chunk exactly as mine", () => {
    const baseline = u8(1);
    const mine = u8(1);
    const remote = u8(1);
    remote[voxelIndex(3, 0, 0)] = 42; // x=3 — outside the owned box

    const result = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(result.merged[voxelIndex(3, 0, 0)]).toBe(1);
    expect(result.acceptedFromRemote).toBe(0);
  });

  it("never mutates its inputs", () => {
    const baseline = u8(1);
    const mine = u8(1);
    const remote = u8(1);
    remote[voxelIndex(1, 0, 0)] = 7;

    mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(Array.from(mine)).toEqual(Array.from(u8(1)));
    expect(Array.from(baseline)).toEqual(Array.from(u8(1)));
  });

  it("merges 32-bit segment ids as whole voxels", () => {
    const geometry = halfOwned({ bytesPerVoxel: 4 });
    const baseline = new Uint32Array(VOXELS_PER_CHANNEL).fill(100);
    const mine = new Uint32Array(baseline);
    const remote = new Uint32Array(baseline);
    remote[voxelIndex(1, 0, 0)] = 999;
    mine[voxelIndex(0, 0, 0)] = 555;

    const result = mergeOwnedRegion(baseline, mine, remote, geometry);
    const merged = new Uint32Array(
      result.merged.buffer,
      result.merged.byteOffset,
      VOXELS_PER_CHANNEL,
    );

    expect(merged[voxelIndex(1, 0, 0)]).toBe(999);
    expect(merged[voxelIndex(0, 0, 0)]).toBe(555);
    expect(result.unresolved).toBe(0);
  });

  it("merges 64-bit segment ids without widening through BigInt", () => {
    const geometry = halfOwned({ bytesPerVoxel: 8 });
    const baseline = new BigUint64Array(VOXELS_PER_CHANNEL).fill(100n);
    const mine = new BigUint64Array(baseline);
    const remote = new BigUint64Array(baseline);
    remote[voxelIndex(1, 0, 0)] = 2n ** 40n;

    const result = mergeOwnedRegion(baseline, mine, remote, geometry);
    const merged = new BigUint64Array(
      result.merged.buffer,
      result.merged.byteOffset,
      VOXELS_PER_CHANNEL,
    );

    expect(merged[voxelIndex(1, 0, 0)]).toBe(2n ** 40n);
    expect(result.acceptedFromRemote).toBe(1);
  });

  it("merges every channel of a multi-channel chunk", () => {
    const geometry = halfOwned({ channels: 2 });
    const size = VOXELS_PER_CHANNEL * 2;
    const baseline = new Uint8Array(size).fill(1);
    const mine = new Uint8Array(baseline);
    const remote = new Uint8Array(baseline);
    remote[voxelIndex(1, 0, 0, 0)] = 7;
    remote[voxelIndex(1, 0, 0, 1)] = 8;

    const result = mergeOwnedRegion(baseline, mine, remote, geometry);

    expect(result.merged[voxelIndex(1, 0, 0, 0)]).toBe(7);
    expect(result.merged[voxelIndex(1, 0, 0, 1)]).toBe(8);
    expect(result.acceptedFromRemote).toBe(2);
  });
});
