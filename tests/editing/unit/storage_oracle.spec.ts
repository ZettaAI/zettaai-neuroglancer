/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import { summarizePatchedVoxels } from "#src/editing/benchmarks/patch_readback.js";
import {
  changedVoxels,
  countValue,
  voxelSetSignature,
  type StoredVolume,
} from "#tests/editing/harness/storage_oracle.js";

/** A 4×3×2 volume, X fastest, every voxel `fill` except the given overrides. */
function volume(
  fill: string,
  overrides: Record<number, string> = {},
): StoredVolume {
  const values = Array.from(
    { length: 4 * 3 * 2 },
    (_, linearIndex) => overrides[linearIndex] ?? fill,
  );
  return { start: [10, 20, 30], end: [14, 23, 32], values };
}

describe("changedVoxels", () => {
  it("reports exactly the differing voxels, in absolute coordinates", () => {
    // linear 0 → (0,0,0); 5 → (1,1,0); 23 → (3,2,1)
    const before = volume("7");
    const after = volume("7", { 0: "9", 5: "9", 23: "4" });
    expect(changedVoxels(before, after)).toEqual([
      { x: 10, y: 20, z: 30, value: "9" },
      { x: 11, y: 21, z: 30, value: "9" },
      { x: 13, y: 22, z: 31, value: "4" },
    ]);
  });

  it("is empty when nothing changed", () => {
    expect(changedVoxels(volume("7"), volume("7"))).toEqual([]);
  });

  it("refuses reads of different boxes", () => {
    const other: StoredVolume = { ...volume("7"), start: [0, 0, 0] };
    expect(() => changedVoxels(volume("7"), other)).toThrow(/different boxes/);
  });
});

describe("countValue", () => {
  it("counts the voxels holding a value", () => {
    expect(countValue(volume("7", { 1: "9", 2: "9" }), "9")).toBe(2);
    expect(countValue(volume("7"), "9")).toBe(0);
  });
});

describe("voxelSetSignature", () => {
  it("matches the app read-back signature for the same voxel set", () => {
    // One 4×4×2 patch chunk at grid (1,0,2), shifted by an origin offset —
    // the same frame the e2e compares in.
    const chunkSize = [4, 4, 2] as const;
    const voxelCount = chunkSize[0] * chunkSize[1] * chunkSize[2];
    const data = Array.from({ length: voxelCount }, () => 0n);
    const patched = new Uint8Array(voxelCount);
    const painted: Array<[number, bigint]> = [
      [0, 18446744073709551615n],
      [5, 42n],
      [17, 42n],
      [31, 3n],
    ];
    for (const [linearIndex, value] of painted) {
      data[linearIndex] = value;
      patched[linearIndex] = 1;
    }
    const origin = [128, 128, 8] as const;
    const app = summarizePatchedVoxels(
      [["1,0,2", { chunkDataSize: chunkSize, data, patched }]],
      { originOffset: origin },
    );

    const voxels = painted.map(([linearIndex, value]) => ({
      x: 1 * chunkSize[0] + (linearIndex % 4) + origin[0],
      y: 0 * chunkSize[1] + (Math.floor(linearIndex / 4) % 4) + origin[1],
      z: 2 * chunkSize[2] + Math.floor(linearIndex / 16) + origin[2],
      value: value.toString(),
    }));
    // Order must not matter: the oracle sorts like the read-back does.
    expect(voxelSetSignature([...voxels].reverse())).toBe(app.signature);
  });

  it("differs when one value differs", () => {
    const base = [{ x: 1, y: 2, z: 3, value: "5" }];
    expect(voxelSetSignature(base)).not.toBe(
      voxelSetSignature([{ ...base[0], value: "6" }]),
    );
  });
});
