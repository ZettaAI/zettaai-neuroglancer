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

import type { CursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import { planPaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import {
  buildTexelToDisplayMatrix,
  chunkBoxToTexelBox,
} from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import { targetVoxelToGlobal } from "#src/editing/raster/global_voxel_conversion.js";
import { mat4, vec3 } from "#src/util/geom.js";

type Triple = readonly [number, number, number];

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

function boxOf(lo: Triple, hi: Triple): ChunkVoxelBox {
  return { x0: lo[0], y0: lo[1], z0: lo[2], x1: hi[0], y1: hi[1], z1: hi[2] };
}

function frameOf(
  globalDimForSlot: Triple,
  globalVoxelSizeNm: Triple,
  targetVoxelSizeNm: Triple,
): CursorVoxelFrame {
  return { globalDimForSlot, globalVoxelSizeNm, targetVoxelSizeNm };
}

function texelToDisplay(matrix: mat4, texel: Triple): number[] {
  const out = vec3.transformMat4(
    vec3.create(),
    vec3.fromValues(...texel),
    matrix,
  );
  return Array.from(out);
}

const WHOLE_CHUNK = boxOf([0, 0, 0], [63, 63, 15]);
const IDENTITY_SLOTS: Triple = [0, 1, 2];
const ANISOTROPIC_NM: Triple = [4, 4, 40];

describe("chunkBoxToTexelBox", () => {
  const extent = extentOf([0, 0, 0], [1, 1, 1], [128, 128, 16]);

  it("offsets a chunk-local box by the chunk origin", () => {
    expect(chunkBoxToTexelBox(extent, [64, 0, 0], WHOLE_CHUNK)).toEqual(
      boxOf([64, 0, 0], [127, 63, 15]),
    );
    expect(
      chunkBoxToTexelBox(extent, [64, 64, 0], boxOf([1, 2, 3], [4, 5, 6])),
    ).toEqual(boxOf([65, 66, 3], [68, 69, 6]));
  });

  it("maps a box to every factor block it touches", () => {
    const downsampled = extentOf([0, 0, 0], [2, 2, 1], [64, 64, 16]);
    // x 3..6 touches blocks 1..3; y 0..1 is block 0; z is not downsampled.
    expect(
      chunkBoxToTexelBox(downsampled, [0, 0, 0], boxOf([3, 0, 5], [6, 1, 9])),
    ).toEqual(boxOf([1, 0, 5], [3, 0, 9]));
    // A box ending on a block's first voxel still includes that block.
    expect(
      chunkBoxToTexelBox(downsampled, [64, 0, 0], boxOf([0, 0, 0], [2, 0, 0])),
    ).toEqual(boxOf([32, 0, 0], [33, 0, 0]));
  });

  it("clips a chunk that sticks out of the texture", () => {
    expect(chunkBoxToTexelBox(extent, [96, 0, 0], WHOLE_CHUNK)).toEqual(
      boxOf([96, 0, 0], [127, 63, 15]),
    );
    const shifted = extentOf([32, 0, 0], [1, 1, 1], [64, 64, 16]);
    expect(chunkBoxToTexelBox(shifted, [0, 0, 0], WHOLE_CHUNK)).toEqual(
      boxOf([0, 0, 0], [31, 63, 15]),
    );
  });

  it("returns undefined for a box entirely outside the texture", () => {
    expect(
      chunkBoxToTexelBox(extent, [128, 0, 0], WHOLE_CHUNK),
    ).toBeUndefined();
    expect(
      chunkBoxToTexelBox(extent, [0, 0, -16], WHOLE_CHUNK),
    ).toBeUndefined();
    expect(
      chunkBoxToTexelBox(extent, [64, 0, 0], boxOf([0, 0, 16], [3, 3, 20])),
    ).toBeUndefined();
  });

  it("accounts for a non-zero voxelOffset", () => {
    const voxelOffset: Triple = [3, 5, 7];
    const offsetExtent = extentOf(voxelOffset, [1, 1, 1], [128, 128, 16]);
    // Chunk (1, 0, 0) starts at index * chunkSize + voxelOffset.
    const chunkOrigin: Triple = [64 + 3, 5, 7];
    expect(
      chunkBoxToTexelBox(
        offsetExtent,
        chunkOrigin,
        boxOf([0, 0, 0], [1, 1, 1]),
      ),
    ).toEqual(boxOf([64, 0, 0], [65, 1, 1]));
  });
});

describe("buildTexelToDisplayMatrix", () => {
  const unitExtent = extentOf([0, 0, 0], [1, 1, 1], [16, 16, 16]);

  it("is a unit scale when target and global voxel sizes match", () => {
    const frame = frameOf(IDENTITY_SLOTS, ANISOTROPIC_NM, ANISOTROPIC_NM);
    const matrix = buildTexelToDisplayMatrix(mat4.create(), frame, unitExtent)!;
    expect(texelToDisplay(matrix, [1, 1, 1])).toEqual([1, 1, 1]);
    expect(texelToDisplay(matrix, [3, 5, 7])).toEqual([3, 5, 7]);
  });

  it("scales by the target-to-global voxel size ratio", () => {
    const frame = frameOf(IDENTITY_SLOTS, ANISOTROPIC_NM, [8, 8, 40]);
    const matrix = buildTexelToDisplayMatrix(mat4.create(), frame, unitExtent)!;
    expect(texelToDisplay(matrix, [1, 1, 1])).toEqual([2, 2, 1]);
  });

  it("places texel (0, 0, 0) at the texture origin", () => {
    const frame = frameOf(IDENTITY_SLOTS, ANISOTROPIC_NM, [8, 8, 40]);
    const extent = extentOf([10, 20, 30], [1, 1, 1], [16, 16, 16]);
    const matrix = buildTexelToDisplayMatrix(mat4.create(), frame, extent)!;
    expect(texelToDisplay(matrix, [0, 0, 0])).toEqual([20, 40, 30]);
  });

  it("scales texel steps by the downsample factor", () => {
    const frame = frameOf(IDENTITY_SLOTS, ANISOTROPIC_NM, ANISOTROPIC_NM);
    const extent = extentOf([10, 20, 30], [2, 2, 1], [16, 16, 16]);
    const matrix = buildTexelToDisplayMatrix(mat4.create(), frame, extent)!;
    expect(texelToDisplay(matrix, [1, 1, 1])).toEqual([12, 22, 31]);
  });

  it("routes each global dimension to the display slot that shows it", () => {
    // Slot 0 shows global z, slot 1 global x, slot 2 global y.
    const frame = frameOf([2, 0, 1], [4, 4, 40], [4, 4, 40]);
    const matrix = buildTexelToDisplayMatrix(mat4.create(), frame, unitExtent)!;
    expect(texelToDisplay(matrix, [1, 2, 3])).toEqual([3, 1, 2]);
  });

  it("agrees with targetVoxelToGlobal for arbitrary texels", () => {
    const frame = frameOf([1, 2, 0], [4, 6, 45], [16, 16, 90]);
    const extent = extentOf([-7, 13, 101], [4, 2, 1], [64, 64, 32]);
    const matrix = buildTexelToDisplayMatrix(mat4.create(), frame, extent)!;
    const texels: Triple[] = [
      [0, 0, 0],
      [1, 2, 3],
      [63, 17, 31],
      [5.5, 0.25, 12],
    ];
    for (const texel of texels) {
      const voxel: Triple = [0, 1, 2].map(
        (axis) =>
          extent.textureOrigin[axis] + texel[axis] * extent.factor[axis],
      ) as unknown as Triple;
      const global = targetVoxelToGlobal(
        voxel,
        frame.globalVoxelSizeNm,
        frame.targetVoxelSizeNm,
      );
      const expected = frame.globalDimForSlot.map((dim) => global[dim]);
      const actual = texelToDisplay(matrix, texel);
      for (let slot = 0; slot < 3; slot++) {
        // `mat4` is a Float32Array: compare at float32 precision.
        expect(actual[slot]).toBeCloseTo(expected[slot], 3);
      }
    }
  });

  it("returns undefined when a painted axis is not displayed", () => {
    const frame = frameOf([0, 1, -1], [4, 4, 0], ANISOTROPIC_NM);
    expect(
      buildTexelToDisplayMatrix(mat4.create(), frame, unitExtent),
    ).toBeUndefined();
  });

  it("puts the proxy-cube corners on the active region box", () => {
    // Restates `EditSessionHost.computeActiveRegionSync` (private) for the
    // case it shares with the preview: region resolution == preview
    // resolution, integral bbox, factor 1.
    const regionVoxelSizeNm: Triple = [8, 8, 40];
    const displayScalesMetres: Triple = [4e-9, 4e-9, 40e-9];
    const bboxLo: Triple = [96, 160, 12];
    const bboxHi: Triple = [480, 352, 44];
    const activeRegion = (voxel: Triple) =>
      voxel.map((coordinate, axis) => {
        const displayVoxelSizeNm =
          Math.round(displayScalesMetres[axis] * 1e9 * 1e6) / 1e6;
        return (coordinate * regionVoxelSizeNm[axis]) / displayVoxelSizeNm;
      });

    const extent = planPaintedVolumeExtent(
      {
        loX: bboxLo[0],
        loY: bboxLo[1],
        loZ: bboxLo[2],
        hiX: bboxHi[0],
        hiY: bboxHi[1],
        hiZ: bboxHi[2],
      },
      [64, 64, 4],
      [0, 0, 0],
      2048,
      256 * 1024 * 1024,
    )!;
    expect(extent.factor).toEqual([1, 1, 1]);
    const frame = frameOf(
      IDENTITY_SLOTS,
      displayScalesMetres.map((metres) => metres * 1e9) as unknown as Triple,
      regionVoxelSizeNm,
    );
    const matrix = buildTexelToDisplayMatrix(mat4.create(), frame, extent)!;

    const lowCorner = texelToDisplay(matrix, [0, 0, 0]);
    const highCorner = texelToDisplay(matrix, extent.textureSize);
    const expectedLow = activeRegion(bboxLo);
    const expectedHigh = activeRegion(bboxHi);
    for (let axis = 0; axis < 3; axis++) {
      expect(lowCorner[axis]).toBeCloseTo(expectedLow[axis], 6);
      expect(highCorner[axis]).toBeCloseTo(expectedHigh[axis], 6);
    }
  });
});
