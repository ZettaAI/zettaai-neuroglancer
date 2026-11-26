/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import type {
  LevelGeometry,
  ResampleSource,
} from "#src/editing/overlay/patch_resampling.js";
import {
  levelGeometryOf,
  resamplePatchBox,
  sameChunkGrid,
  sameLevel,
  targetBoxesForStoredChange,
} from "#src/editing/overlay/patch_resampling.js";
import type { vec3 } from "#src/util/geom.js";

/** A level `scale` model units per voxel in x/y (z = 1), chunks of `size`. */
function level(
  scale: number,
  size: [number, number, number],
  options: { offset?: number; upper?: [number, number, number] } = {},
): LevelGeometry {
  const offset = options.offset ?? 0;
  return {
    axes: [
      { scale, offset },
      { scale, offset },
      { scale: 1, offset: 0 },
    ],
    chunkDataSize: size,
    lowerVoxelBound: [0, 0, 0],
    upperVoxelBound: options.upper ?? [Infinity, Infinity, Infinity],
  };
}

function chunkOf(size: [number, number, number]) {
  return new LocalPatchChunk(size as unknown as vec3);
}

/** Paint `value` at voxels `[x, y]` (z = 0) of `chunk`. */
function paint(
  chunk: LocalPatchChunk,
  voxels: [number, number][],
  value: bigint,
) {
  const [sizeX] = chunk.chunkDataSize;
  for (const [x, y] of voxels) {
    chunk.data[x + sizeX * y] = value;
    chunk.patched[x + sizeX * y] = 1;
  }
}

function patchedVoxels(chunk: LocalPatchChunk) {
  const [sizeX] = chunk.chunkDataSize;
  const result: string[] = [];
  chunk.patched.forEach((patched, index) => {
    if (patched === 1) {
      result.push(
        `${index % sizeX},${Math.floor(index / sizeX)}=${chunk.data[index]}`,
      );
    }
  });
  return result;
}

function wholeBox(sizeX: number, sizeY: number) {
  return { x0: 0, y0: 0, z0: 0, x1: sizeX - 1, y1: sizeY - 1, z1: 0 };
}

/** A source whose only chunk is `chunk` at grid `[gridX, gridY, 0]`. */
function sourceOf(
  geometry: LevelGeometry,
  chunk: LocalPatchChunk,
  gridX = 0,
  gridY = 0,
): ResampleSource {
  return {
    geometry,
    chunkAt: (x, y, z) =>
      x === gridX && y === gridY && z === 0 ? chunk : undefined,
  };
}

const FINE = level(1, [4, 4, 1]);
const COARSE = level(2, [4, 4, 1]);

describe("levelGeometryOf", () => {
  it("reads scale, offset and volume bound per axis", () => {
    // rank 3, column-major 4×4: scale 2/2/1, translation 10/20/0.
    const transform = Float32Array.from([
      2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1,
    ]);
    const geometry = levelGeometryOf({
      chunkToMultiscaleTransform: transform,
      chunkSource: {
        spec: {
          rank: 3,
          chunkDataSize: [64, 64, 16],
          upperVoxelBound: [100, 90, 16],
        },
      },
    });
    expect(geometry).toEqual({
      axes: [
        { scale: 2, offset: 10 },
        { scale: 2, offset: 20 },
        { scale: 1, offset: 0 },
      ],
      chunkDataSize: [64, 64, 16],
      lowerVoxelBound: [0, 0, 0],
      upperVoxelBound: [100, 90, 16],
    });
  });

  it("an absurd chunk size is not resampled", () => {
    expect(
      levelGeometryOf({
        chunkToMultiscaleTransform: Float32Array.from([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ]),
        chunkSource: {
          spec: { rank: 3, chunkDataSize: [1 << 20, 1 << 20, 1] },
        },
      }),
    ).toBeUndefined();
  });

  it("rotated and flipped levels are not resampled", () => {
    const spec = { rank: 3, chunkDataSize: [64, 64, 16] };
    const rotated = Float32Array.from([
      0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const flipped = Float32Array.from([
      -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    for (const transform of [rotated, flipped]) {
      expect(
        levelGeometryOf({
          chunkToMultiscaleTransform: transform,
          chunkSource: { spec },
        }),
      ).toBeUndefined();
    }
  });
});

describe("resamplePatchBox", () => {
  it("coarser level: a voxel shows the edit when half or more of its block has it", () => {
    const stored = chunkOf([4, 4, 1]);
    // Block (0,0): all 4 → shown. Block (1,0): 2 of 4 → shown (tie goes to the
    // edit). Block (0,1): 1 of 4 → not shown.
    paint(
      stored,
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ],
      7n,
    );
    paint(
      stored,
      [
        [2, 0],
        [3, 0],
      ],
      9n,
    );
    paint(stored, [[0, 2]], 5n);
    const target = chunkOf([4, 4, 1]);
    resamplePatchBox(
      [sourceOf(FINE, stored)],
      COARSE,
      [0, 0, 0],
      target,
      wholeBox(4, 4),
    );
    expect(patchedVoxels(target)).toEqual(["0,0=7", "1,0=9"]);
  });

  it("finer level: every voxel takes the edit of the coarse voxel holding it", () => {
    const stored = chunkOf([4, 4, 1]);
    paint(stored, [[1, 0]], 3n);
    const target = chunkOf([4, 4, 1]);
    resamplePatchBox(
      [sourceOf(COARSE, stored)],
      FINE,
      [0, 0, 0],
      target,
      wholeBox(4, 4),
    );
    expect(patchedVoxels(target)).toEqual(["2,0=3", "3,0=3", "2,1=3", "3,1=3"]);
  });

  it("reads across stored chunk borders and uses the target chunk's grid", () => {
    // Stored chunks of 2×2: the coarse voxel (2,0) of target chunk (0,0)
    // covers stored voxels 4..5, i.e. stored chunk (2,0).
    const storedChunk = chunkOf([2, 2, 1]);
    paint(
      storedChunk,
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ],
      4n,
    );
    const target = chunkOf([4, 4, 1]);
    resamplePatchBox(
      [sourceOf(level(1, [2, 2, 1]), storedChunk, 2, 0)],
      COARSE,
      [0, 0, 0],
      target,
      wholeBox(4, 4),
    );
    expect(patchedVoxels(target)).toEqual(["2,0=4"]);
  });

  it("levels with different offsets line up in model space", () => {
    // Coarse level starts 2 model units later: its voxel 0 covers fine 2..3
    // along x and y.
    const stored = chunkOf([4, 4, 1]);
    paint(
      stored,
      [
        [2, 2],
        [3, 2],
        [2, 3],
        [3, 3],
      ],
      8n,
    );
    const target = chunkOf([4, 4, 1]);
    resamplePatchBox(
      [sourceOf(FINE, stored)],
      level(2, [4, 4, 1], { offset: 2 }),
      [0, 0, 0],
      target,
      wholeBox(4, 4),
    );
    expect(patchedVoxels(target)).toEqual(["0,0=8"]);
  });

  it("stored chunks clipped to the volume (TM-373) are read by their own size", () => {
    // The session's only chunk is 6×5 (the whole volume), not a full 8×8:
    // indexing it as 8 wide would read past its end.
    const stored = chunkOf([6, 5, 1]);
    paint(
      stored,
      [
        [4, 2],
        [5, 2],
        [4, 3],
        [5, 3],
      ],
      6n,
    );
    const coarse = level(2, [8, 8, 1], { upper: [3, 3, 1] });
    const target = chunkOf([8, 8, 1]);
    expect(() =>
      resamplePatchBox(
        [sourceOf(level(1, [6, 5, 1]), stored)],
        coarse,
        [0, 0, 0],
        target,
        wholeBox(3, 3),
      ),
    ).not.toThrow();
    expect(patchedVoxels(target)).toEqual(["2,1=6"]);
  });

  it("several sources: each voxel from the first source with an edit there", () => {
    const own = chunkOf([4, 4, 1]);
    paint(own, [[0, 0]], 1n);
    // The other source covers (0,0)..(1,1) of the target with 2.
    const other = chunkOf([4, 4, 1]);
    paint(other, [[0, 0]], 2n);
    const target = chunkOf([4, 4, 1]);
    resamplePatchBox(
      [sourceOf(FINE, own), sourceOf(COARSE, other)],
      FINE,
      [0, 0, 0],
      target,
      wholeBox(4, 4),
    );
    expect(patchedVoxels(target)).toEqual(["0,0=1", "1,0=2", "0,1=2", "1,1=2"]);
  });

  it("only the box is rebuilt; an edit undone clears it", () => {
    const stored = chunkOf([4, 4, 1]);
    const target = chunkOf([4, 4, 1]);
    paint(
      target,
      [
        [0, 0],
        [3, 3],
      ],
      1n,
    );
    resamplePatchBox([sourceOf(FINE, stored)], COARSE, [0, 0, 0], target, {
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 1,
      y1: 1,
      z1: 0,
    });
    // (0,0) inside the box: nothing stored → cleared; (3,3) outside: kept.
    expect(patchedVoxels(target)).toEqual(["3,3=1"]);
  });
});

describe("targetBoxesForStoredChange", () => {
  it("maps a stored box to the coarse chunk boxes that depend on it", () => {
    // Fine voxels 6..8 → coarse voxels 3..4 → coarse chunks of 4: chunk 0
    // local 3, chunk 1 local 0.
    const boxes = targetBoxesForStoredChange(
      level(1, [8, 8, 1]),
      [0, 0, 0],
      { x0: 6, y0: 0, z0: 0, x1: 8, y1: 0, z1: 0 },
      COARSE,
    );
    expect(boxes).toEqual([
      {
        gridPosition: [0, 0, 0],
        box: { x0: 3, y0: 0, z0: 0, x1: 3, y1: 0, z1: 0 },
      },
      {
        gridPosition: [1, 0, 0],
        box: { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 },
      },
    ]);
  });

  it("a whole stored chunk maps to the finer voxels it covers", () => {
    const boxes = targetBoxesForStoredChange(
      level(2, [2, 2, 1]),
      [1, 0, 0],
      null,
      level(1, [8, 8, 1]),
    );
    expect(boxes).toEqual([
      {
        gridPosition: [0, 0, 0],
        box: { x0: 4, y0: 0, z0: 0, x1: 7, y1: 3, z1: 0 },
      },
    ]);
  });

  it("boxes stop at the target volume's bound", () => {
    const boxes = targetBoxesForStoredChange(
      level(1, [8, 8, 1]),
      [0, 0, 0],
      null,
      level(2, [8, 8, 1], { upper: [3, 2, 1] }),
    );
    expect(boxes).toEqual([
      {
        gridPosition: [0, 0, 0],
        box: { x0: 0, y0: 0, z0: 0, x1: 2, y1: 1, z1: 0 },
      },
    ]);
  });
});

it("sameLevel compares grid and chunking", () => {
  expect(sameLevel(level(1, [4, 4, 1]), level(1, [4, 4, 1]))).toBe(true);
  expect(sameLevel(level(1, [4, 4, 1]), level(2, [4, 4, 1]))).toBe(false);
  expect(sameLevel(level(1, [4, 4, 1]), level(1, [8, 8, 1]))).toBe(false);
});

it("sameChunkGrid accepts a chunk clipped to a volume that fits in one chunk", () => {
  const nominal = level(1, [4096, 4096, 1], { upper: [1238, 1065, 1] });
  const clipped = level(1, [1238, 1065, 1], { upper: [1238, 1065, 1] });
  expect(sameChunkGrid(clipped, nominal)).toBe(true);
  // A volume of several chunks: the chunk sizes must match.
  const big = level(1, [4096, 4096, 1], { upper: [9000, 9000, 1] });
  expect(sameChunkGrid(level(1, [2048, 2048, 1]), big)).toBe(false);
});
