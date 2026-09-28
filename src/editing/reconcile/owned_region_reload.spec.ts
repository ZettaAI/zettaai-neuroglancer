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
  mustReloadFromRemote,
  reloadedOwnedRegion,
} from "#src/editing/reconcile/owned_region_reload.js";
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

describe("mustReloadFromRemote", () => {
  it("is false when every voxel resolved", () => {
    const baseline = u8(1);
    const mine = u8(1);
    mine[voxelIndex(0, 0, 0)] = 9;
    const remote = u8(1);
    remote[voxelIndex(1, 0, 0)] = 7;

    expect(
      mustReloadFromRemote(
        mergeOwnedRegion(baseline, mine, remote, halfOwned()),
      ),
    ).toBe(false);
  });

  /**
   * The rule at its least intuitive, and the one worth pinning: a single
   * colliding voxel condemns the whole owned box, however much work is in it.
   */
  it("is true for a single colliding voxel", () => {
    const baseline = u8(1);
    const mine = u8(1);
    mine[voxelIndex(0, 0, 0)] = 9;
    const remote = u8(1);
    remote[voxelIndex(0, 0, 0)] = 7;

    const merge = mergeOwnedRegion(baseline, mine, remote, halfOwned());

    expect(merge.unresolved).toBe(1);
    expect(mustReloadFromRemote(merge)).toBe(true);
  });
});

describe("reloadedOwnedRegion", () => {
  it("replaces every owned voxel with the remote's", () => {
    const mine = u8(9);
    const remote = u8(7);

    const reloaded = reloadedOwnedRegion(mine, remote, halfOwned());

    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 2; x++) {
          expect(reloaded[voxelIndex(x, y, z)]).toBe(7);
        }
      }
    }
  });

  /**
   * The load-bearing one. Voxels outside the owned box belong to a
   * neighbouring task — which is the only reason two tasks share a chunk at
   * all. A reload that took the remote wholesale would pass the test above
   * and still revert a colleague's half of the chunk in our overlay.
   */
  it("leaves voxels outside the owned box exactly as mine", () => {
    const mine = u8(9);
    const remote = u8(7);

    const reloaded = reloadedOwnedRegion(mine, remote, halfOwned());

    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 2; x < 4; x++) {
          expect(reloaded[voxelIndex(x, y, z)]).toBe(9);
        }
      }
    }
  });

  it("never mutates its inputs", () => {
    const mine = u8(9);
    const remote = u8(7);

    reloadedOwnedRegion(mine, remote, halfOwned());

    expect(Array.from(mine)).toEqual(Array.from(u8(9)));
    expect(Array.from(remote)).toEqual(Array.from(u8(7)));
  });

  /**
   * An erase is painting zero, so a reload has to be able to bring a zero
   * back as readily as a label — the same asymmetry a non-zero union gets
   * wrong in the merge.
   */
  it("restores a zero the remote holds over a label I painted", () => {
    const mine = u8(0);
    mine[voxelIndex(1, 1, 0)] = 5;
    const remote = u8(0);

    const reloaded = reloadedOwnedRegion(mine, remote, halfOwned());

    expect(reloaded[voxelIndex(1, 1, 0)]).toBe(0);
  });

  it("covers every channel of a multi-channel chunk", () => {
    const owned = halfOwned({ channels: 2 });
    const mine = new Uint8Array(VOXELS_PER_CHANNEL * 2).fill(9);
    const remote = new Uint8Array(VOXELS_PER_CHANNEL * 2).fill(7);

    const reloaded = reloadedOwnedRegion(mine, remote, owned);

    expect(reloaded[voxelIndex(0, 0, 0, 1)]).toBe(7);
    expect(reloaded[voxelIndex(3, 0, 0, 1)]).toBe(9);
  });

  it("handles a wider voxel type without a per-dtype branch", () => {
    const owned = halfOwned({ bytesPerVoxel: 4 });
    const mine = new Uint8Array(VOXELS_PER_CHANNEL * 4).fill(9);
    const remote = new Uint8Array(VOXELS_PER_CHANNEL * 4).fill(7);

    const reloaded = reloadedOwnedRegion(mine, remote, owned);

    // Owned x in [0,2) => bytes [0,8) of each row; the neighbour's half stays.
    expect(Array.from(reloaded.subarray(0, 8))).toEqual(Array(8).fill(7));
    expect(Array.from(reloaded.subarray(8, 16))).toEqual(Array(8).fill(9));
  });
});
