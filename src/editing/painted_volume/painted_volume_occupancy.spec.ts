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

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import type {
  BaselineVoxelView,
  PaintedVolumeChunkVoxels,
} from "#src/editing/painted_volume/painted_volume_occupancy.js";
import {
  chunkHasShownVoxel,
  writeOccupancyForBox,
} from "#src/editing/painted_volume/painted_volume_occupancy.js";
import { PaintedVolumeSegmentPalette } from "#src/editing/painted_volume/painted_volume_segment_palette.js";
import type { PaintedVolumeShownSegments } from "#src/editing/painted_volume/painted_volume_shown_segments.js";
import { vec3 } from "#src/util/geom.js";

type Triple = readonly [number, number, number];

const CHUNK_SIZE: Triple = [4, 4, 2];
const CHUNK_VOLUME = CHUNK_SIZE[0] * CHUNK_SIZE[1] * CHUNK_SIZE[2];
const WHOLE_CHUNK = boxOf([0, 0, 0], [3, 3, 1]);

const SELECTED = 5n;
const OTHER_SELECTED = 9n;
const NOT_SELECTED = 77n;
const shownSet = new Set([SELECTED, OTHER_SELECTED, 1n << 40n]);
const SHOWN: PaintedVolumeShownSegments = { has: (id) => shownSet.has(id) };

function boxOf(lo: Triple, hi: Triple): ChunkVoxelBox {
  return { x0: lo[0], y0: lo[1], z0: lo[2], x1: hi[0], y1: hi[1], z1: hi[2] };
}

function extentOf(
  textureOrigin: Triple,
  factor: Triple,
  textureSize: Triple,
): PaintedVolumeExtent {
  return {
    textureOrigin: [...textureOrigin],
    factor: [...factor],
    textureSize: [...textureSize],
  };
}

/** Texture exactly covering one chunk at the origin, at full resolution. */
const ONE_CHUNK_EXTENT = extentOf([0, 0, 0], [1, 1, 1], CHUNK_SIZE);

function voxelIndex(x: number, y: number, z: number): number {
  return (z * CHUNK_SIZE[1] + y) * CHUNK_SIZE[0] + x;
}

function chunkOf(
  baseline: BaselineVoxelView,
  patch?: LocalPatchChunk,
  origin: Triple = [0, 0, 0],
): PaintedVolumeChunkVoxels {
  return { origin, size: CHUNK_SIZE, baseline, patch };
}

function emptyPatch(): LocalPatchChunk {
  return new LocalPatchChunk(vec3.fromValues(...CHUNK_SIZE));
}

function writePatch(
  patch: LocalPatchChunk,
  index: number,
  value: bigint,
  patched = 1,
): void {
  patch.data[index] = value;
  patch.patched[index] = patched;
}

/** Texel byte at texel (x, y, z) of a written box. */
function texelAt(
  write: NonNullable<ReturnType<typeof writeOccupancyForBox>>,
  x: number,
  y: number,
  z: number,
): number {
  const { texelBox, bytes } = write;
  const width = texelBox.x1 - texelBox.x0 + 1;
  const height = texelBox.y1 - texelBox.y0 + 1;
  return bytes[
    ((z - texelBox.z0) * height + (y - texelBox.y0)) * width + (x - texelBox.x0)
  ];
}

describe("writeOccupancyForBox at factor 1", () => {
  it("maps every voxel to its own texel, byte for byte", () => {
    const palette = new PaintedVolumeSegmentPalette();
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[voxelIndex(1, 2, 0)] = Number(SELECTED);
    baseline[voxelIndex(3, 3, 1)] = Number(OTHER_SELECTED);
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      palette,
    )!;
    expect(write.texelBox).toEqual(WHOLE_CHUNK);
    const expected = new Uint8Array(CHUNK_VOLUME);
    expected[voxelIndex(1, 2, 0)] = palette.classOf(Number(SELECTED), 0);
    expected[voxelIndex(3, 3, 1)] = palette.classOf(Number(OTHER_SELECTED), 0);
    expect(Array.from(write.bytes)).toEqual(Array.from(expected));
    expect(write.occupied).toBe(true);
  });

  it("writes only the requested box", () => {
    const palette = new PaintedVolumeSegmentPalette();
    const baseline = new Uint32Array(CHUNK_VOLUME).fill(Number(SELECTED));
    const box = boxOf([1, 1, 1], [2, 3, 1]);
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      box,
      ONE_CHUNK_EXTENT,
      SHOWN,
      palette,
    )!;
    expect(write.texelBox).toEqual(box);
    expect(write.bytes.length).toBe(2 * 3 * 1);
    expect(Array.from(write.bytes).every((value) => value === 1)).toBe(true);
  });

  it("reports an empty box as unoccupied", () => {
    const write = writeOccupancyForBox(
      chunkOf(new Uint32Array(CHUNK_VOLUME)),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(write.occupied).toBe(false);
    expect(Array.from(write.bytes).every((value) => value === 0)).toBe(true);
  });

  it("leaves segments that are not shown empty", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME).fill(Number(NOT_SELECTED));
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(write.occupied).toBe(false);
  });

  it("reuses a scratch buffer that is large enough", () => {
    const scratch = new Uint8Array(1024).fill(200);
    const write = writeOccupancyForBox(
      chunkOf(new Uint32Array(CHUNK_VOLUME)),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
      scratch,
    )!;
    expect(write.bytes.buffer).toBe(scratch.buffer);
    expect(write.bytes.length).toBe(CHUNK_VOLUME);
    expect(Array.from(write.bytes).every((value) => value === 0)).toBe(true);
  });
});

describe("writeOccupancyForBox composite", () => {
  it("takes the baseline where the voxel is not patched", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[0] = Number(SELECTED);
    const patch = emptyPatch();
    writePatch(patch, 0, OTHER_SELECTED, 0);
    const palette = new PaintedVolumeSegmentPalette();
    const write = writeOccupancyForBox(
      chunkOf(baseline, patch),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      palette,
    )!;
    expect(texelAt(write, 0, 0, 0)).toBe(palette.classOf(Number(SELECTED), 0));
  });

  it("takes the patch value where the voxel is patched", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[0] = Number(SELECTED);
    const patch = emptyPatch();
    writePatch(patch, 0, OTHER_SELECTED);
    const palette = new PaintedVolumeSegmentPalette();
    const write = writeOccupancyForBox(
      chunkOf(baseline, patch),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      palette,
    )!;
    expect(texelAt(write, 0, 0, 0)).toBe(
      palette.classOf(Number(OTHER_SELECTED), 0),
    );
  });

  it("shows an erased voxel of a selected segment as empty", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[0] = Number(SELECTED);
    const patch = emptyPatch();
    writePatch(patch, 0, 0n);
    const write = writeOccupancyForBox(
      chunkOf(baseline, patch),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(texelAt(write, 0, 0, 0)).toBe(0);
    expect(write.occupied).toBe(false);
  });

  it("shows a voxel overpainted with its own baseline id (patched = 0)", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[0] = Number(SELECTED);
    const patch = emptyPatch();
    writePatch(patch, 0, SELECTED, 0);
    const write = writeOccupancyForBox(
      chunkOf(baseline, patch),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(texelAt(write, 0, 0, 0)).not.toBe(0);
  });

  it("reads 64-bit patch values", () => {
    const patch = emptyPatch();
    writePatch(patch, 0, 1n << 40n);
    const palette = new PaintedVolumeSegmentPalette();
    const write = writeOccupancyForBox(
      chunkOf(new Uint32Array(CHUNK_VOLUME), patch),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      palette,
    )!;
    expect(texelAt(write, 0, 0, 0)).toBe(palette.classOf(0, 1 << 8));
  });

  it.each([
    ["Uint8Array", () => new Uint8Array(CHUNK_VOLUME)],
    ["Uint16Array", () => new Uint16Array(CHUNK_VOLUME)],
    ["Uint32Array", () => new Uint32Array(CHUNK_VOLUME)],
  ] as const)("reads a %s baseline", (_name, makeBaseline) => {
    const baseline = makeBaseline();
    baseline[voxelIndex(2, 1, 1)] = Number(SELECTED);
    const palette = new PaintedVolumeSegmentPalette();
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      palette,
    )!;
    expect(texelAt(write, 2, 1, 1)).toBe(palette.classOf(Number(SELECTED), 0));
    expect(texelAt(write, 1, 1, 1)).toBe(0);
  });

  it("reads a BigUint64Array baseline, high word included", () => {
    const baseline = new BigUint64Array(CHUNK_VOLUME);
    baseline[voxelIndex(2, 1, 1)] = 1n << 40n;
    baseline[voxelIndex(0, 0, 0)] = (1n << 40n) | SELECTED;
    const palette = new PaintedVolumeSegmentPalette();
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      WHOLE_CHUNK,
      ONE_CHUNK_EXTENT,
      SHOWN,
      palette,
    )!;
    expect(texelAt(write, 2, 1, 1)).toBe(palette.classOf(0, 1 << 8));
    expect(texelAt(write, 0, 0, 0)).toBe(0);
  });
});

describe("writeOccupancyForBox downsampled", () => {
  const HALVING_EXTENT = extentOf([0, 0, 0], [2, 2, 2], [2, 2, 1]);

  it("marks a texel occupied when one of its 8 voxels is", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[voxelIndex(3, 2, 1)] = Number(SELECTED);
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      WHOLE_CHUNK,
      HALVING_EXTENT,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(write.texelBox).toEqual(boxOf([0, 0, 0], [1, 1, 0]));
    expect(texelAt(write, 1, 1, 0)).toBe(1);
    expect(texelAt(write, 0, 0, 0)).toBe(0);
    expect(texelAt(write, 1, 0, 0)).toBe(0);
    expect(texelAt(write, 0, 1, 0)).toBe(0);
  });

  it("takes the first shown voxel's class for a mixed block", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[voxelIndex(0, 0, 0)] = Number(NOT_SELECTED);
    baseline[voxelIndex(1, 0, 0)] = Number(OTHER_SELECTED);
    baseline[voxelIndex(0, 1, 1)] = Number(SELECTED);
    const palette = new PaintedVolumeSegmentPalette();
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      WHOLE_CHUNK,
      HALVING_EXTENT,
      SHOWN,
      palette,
    )!;
    expect(texelAt(write, 0, 0, 0)).toBe(
      palette.classOf(Number(OTHER_SELECTED), 0),
    );
  });

  it("widens a partial box to whole blocks so an erase leaves no ghost", () => {
    // Voxel (0,0,0) still holds the segment; the stroke only touched (1,1,1),
    // which shares its block. The texel must stay occupied from (0,0,0).
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[voxelIndex(0, 0, 0)] = Number(SELECTED);
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      boxOf([1, 1, 1], [1, 1, 1]),
      HALVING_EXTENT,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(write.texelBox).toEqual(boxOf([0, 0, 0], [0, 0, 0]));
    expect(texelAt(write, 0, 0, 0)).toBe(1);
    expect(write.occupied).toBe(true);
  });

  it("never reads past the chunk when widening a box at its far edge", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[voxelIndex(3, 3, 1)] = Number(SELECTED);
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      boxOf([3, 3, 1], [3, 3, 1]),
      HALVING_EXTENT,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(write.texelBox).toEqual(boxOf([1, 1, 0], [1, 1, 0]));
    expect(write.bytes.length).toBe(1);
    expect(texelAt(write, 1, 1, 0)).toBe(1);
  });
});

describe("writeOccupancyForBox placement", () => {
  it("places a chunk away from the texture origin", () => {
    // Texture starts at voxel (10, 20, 0), chunk at (14, 20, 2).
    const extent = extentOf([10, 20, 0], [1, 1, 1], [8, 4, 4]);
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[voxelIndex(1, 2, 1)] = Number(SELECTED);
    const write = writeOccupancyForBox(
      chunkOf(baseline, undefined, [14, 20, 2]),
      WHOLE_CHUNK,
      extent,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(write.texelBox).toEqual(boxOf([4, 0, 2], [7, 3, 3]));
    expect(texelAt(write, 5, 2, 3)).toBe(1);
  });

  it("clips a chunk that sticks out of the texture", () => {
    const extent = extentOf([0, 0, 0], [1, 1, 1], [2, 4, 2]);
    const baseline = new Uint32Array(CHUNK_VOLUME).fill(Number(SELECTED));
    const write = writeOccupancyForBox(
      chunkOf(baseline),
      WHOLE_CHUNK,
      extent,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    )!;
    expect(write.texelBox).toEqual(boxOf([0, 0, 0], [1, 3, 1]));
    expect(write.bytes.length).toBe(2 * 4 * 2);
  });

  it("returns undefined for a box entirely outside the texture", () => {
    const extent = extentOf([100, 0, 0], [1, 1, 1], [4, 4, 2]);
    const write = writeOccupancyForBox(
      chunkOf(new Uint32Array(CHUNK_VOLUME)),
      WHOLE_CHUNK,
      extent,
      SHOWN,
      new PaintedVolumeSegmentPalette(),
    );
    expect(write).toBeUndefined();
  });
});

describe("chunkHasShownVoxel", () => {
  it("is false for a chunk without shown segments", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME).fill(Number(NOT_SELECTED));
    expect(chunkHasShownVoxel(chunkOf(baseline), SHOWN)).toBe(false);
  });

  it("finds a single shown voxel in the last index", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[CHUNK_VOLUME - 1] = Number(SELECTED);
    expect(chunkHasShownVoxel(chunkOf(baseline), SHOWN)).toBe(true);
  });

  it("sees the composite: an erased last voxel leaves nothing", () => {
    const baseline = new Uint32Array(CHUNK_VOLUME);
    baseline[CHUNK_VOLUME - 1] = Number(SELECTED);
    const patch = emptyPatch();
    writePatch(patch, CHUNK_VOLUME - 1, 0n);
    expect(chunkHasShownVoxel(chunkOf(baseline, patch), SHOWN)).toBe(false);
  });

  it("sees the composite: a painted voxel over empty baseline counts", () => {
    const patch = emptyPatch();
    writePatch(patch, 3, SELECTED);
    expect(
      chunkHasShownVoxel(chunkOf(new Uint32Array(CHUNK_VOLUME), patch), SHOWN),
    ).toBe(true);
  });
});
