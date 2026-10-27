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
 * @file Coordinate frames of the painted-volume texture.
 *
 * Two mappings, both pure:
 * - chunk → texel: which texels a chunk-local voxel box lands in;
 * - texel → display: the model matrix that places the texture in the
 *   perspective view, built on the same `CursorVoxelFrame` the brush cursor
 *   uses. Like the cursor and `globalToTargetVoxel`, it applies only the
 *   nanometre ratio and the display-axis permutation and ignores the layer's
 *   source transform; changing that assumption means changing all three.
 */

import type { CursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import type { mat4 } from "#src/util/geom.js";

/** Inclusive texel box, same convention as `ChunkVoxelBox`. */
export interface TexelBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/** Global dimensions the texture's x, y, z axes are painted in. */
const PAINTED_GLOBAL_DIMS = [0, 1, 2] as const;

/**
 * Texels covering the chunk-local inclusive `chunkLocalBox` of the chunk whose
 * first voxel is `chunkOrigin` (absolute voxels, e.g. `ChunkGrid.chunkOriginOf`),
 * clipped to the texture; `undefined` when nothing of it lies inside. A
 * downsampled texel is included when the box touches any of its voxels.
 */
export function chunkBoxToTexelBox(
  extent: PaintedVolumeExtent,
  chunkOrigin: readonly [number, number, number],
  chunkLocalBox: ChunkVoxelBox,
): TexelBox | undefined {
  const lows = [chunkLocalBox.x0, chunkLocalBox.y0, chunkLocalBox.z0];
  const highs = [chunkLocalBox.x1, chunkLocalBox.y1, chunkLocalBox.z1];
  const texelLows: number[] = [];
  const texelHighs: number[] = [];
  for (const axis of PAINTED_GLOBAL_DIMS) {
    const textureFirstVoxel = extent.textureOrigin[axis];
    const textureLastVoxel =
      textureFirstVoxel + extent.textureSize[axis] * extent.factor[axis] - 1;
    const firstVoxel = Math.max(
      chunkOrigin[axis] + lows[axis],
      textureFirstVoxel,
    );
    const lastVoxel = Math.min(
      chunkOrigin[axis] + highs[axis],
      textureLastVoxel,
    );
    if (lastVoxel < firstVoxel) return undefined;
    texelLows.push(texelOfVoxel(extent, axis, firstVoxel));
    texelHighs.push(texelOfVoxel(extent, axis, lastVoxel));
  }
  return {
    x0: texelLows[0],
    y0: texelLows[1],
    z0: texelLows[2],
    x1: texelHighs[0],
    y1: texelHighs[1],
    z1: texelHighs[2],
  };
}

/**
 * Write into `out` the matrix taking a texel coordinate (`[0, textureSize]`
 * per axis; texel corners are integers) to display coordinates:
 *
 *     voxel         = textureOrigin + texel * factor
 *     display[slot] = voxel[dim] * targetVoxelSizeNm[dim] / globalVoxelSizeNm[dim]
 *
 * for each display `slot` showing global dimension `dim`. Returns `undefined`
 * (leaving `out` untouched) when one of the three painted dimensions is not
 * displayed, since the volume then has no 3-D placement.
 */
export function buildTexelToDisplayMatrix(
  out: mat4,
  frame: CursorVoxelFrame,
  extent: PaintedVolumeExtent,
): mat4 | undefined {
  const slotForDim = PAINTED_GLOBAL_DIMS.map((dim) =>
    frame.globalDimForSlot.indexOf(dim),
  );
  if (slotForDim.some((slot) => slot < 0)) return undefined;
  out.fill(0);
  for (const dim of PAINTED_GLOBAL_DIMS) {
    const slot = slotForDim[dim];
    const displayUnitsPerVoxel =
      frame.targetVoxelSizeNm[dim] / frame.globalVoxelSizeNm[dim];
    out[columnMajorIndex(dim, slot)] =
      extent.factor[dim] * displayUnitsPerVoxel;
    out[columnMajorIndex(TRANSLATION_COLUMN, slot)] =
      extent.textureOrigin[dim] * displayUnitsPerVoxel;
  }
  out[columnMajorIndex(TRANSLATION_COLUMN, HOMOGENEOUS_ROW)] = 1;
  return out;
}

const TRANSLATION_COLUMN = 3;
const HOMOGENEOUS_ROW = 3;

/** gl-matrix stores `mat4` column-major. */
function columnMajorIndex(column: number, row: number): number {
  return column * 4 + row;
}

function texelOfVoxel(
  extent: PaintedVolumeExtent,
  axis: number,
  voxel: number,
): number {
  return Math.floor((voxel - extent.textureOrigin[axis]) / extent.factor[axis]);
}
