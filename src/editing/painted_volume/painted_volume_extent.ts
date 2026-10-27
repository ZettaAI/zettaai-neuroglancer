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
 * @file Sizing of the painted-volume class texture: which voxels of the session
 * region it covers and how far each axis is downsampled.
 *
 * The texture covers the session region on the preview resolution's voxel
 * grid. When the region exceeds `maxTextureDim` on an axis, or the whole
 * texture (one byte per texel, R8UI) exceeds the memory budget, axes are
 * downsampled by power-of-two factors — x and y first, z only when x and y can
 * go no further, since z is usually the coarse anisotropic axis already.
 *
 * A factor must divide the axis' `chunkDataSize`, and the texture origin is
 * aligned down to the factor grid anchored at `voxelOffset` (where the chunk
 * grid starts). Together these keep every factor block inside one chunk, so
 * the per-chunk occupancy kernel can write a texel from that chunk alone
 * without erasing a neighbour chunk's contribution.
 */

import type { SessionVoxelBounds } from "@zettaai/edit-session";

type AxisTriple = readonly [number, number, number];

const X = 0;
const Y = 1;
const Z = 2;

/** Texture placement, in voxels of the preview resolution. */
export interface PaintedVolumeExtent {
  /** Voxel at texel (0, 0, 0); aligned down to the factor grid of the chunks. */
  readonly textureOrigin: [number, number, number];
  /** Voxels per texel along each axis: a power of two dividing the chunk size. */
  readonly factor: [number, number, number];
  /** Texels along each axis; the texture ends at or past the region's `hi`. */
  readonly textureSize: [number, number, number];
}

/** GPU bytes per texel: one class byte and one coverage byte. */
export const PAINTED_VOLUME_BYTES_PER_TEXEL = 2;

/**
 * Plan the texture for the session region `bounds` (exclusive `hi`), or
 * `undefined` when the region is empty or no allowed factor fits both
 * `maxTextureDim` and `budgetBytes`.
 */
export function planPaintedVolumeExtent(
  bounds: SessionVoxelBounds,
  chunkDataSize: AxisTriple,
  voxelOffset: AxisTriple,
  maxTextureDim: number,
  budgetBytes: number,
): PaintedVolumeExtent | undefined {
  if (maxTextureDim <= 0 || budgetBytes <= 0) return undefined;
  const lo: AxisTriple = [bounds.loX, bounds.loY, bounds.loZ];
  const hi: AxisTriple = [bounds.hiX, bounds.hiY, bounds.hiZ];
  if (lo.some((low, axis) => hi[axis] <= low)) return undefined;

  const maxFactor = chunkDataSize.map(largestPowerOfTwoDivisor);
  const factor: [number, number, number] = [1, 1, 1];
  for (const axis of [X, Y, Z]) {
    const fitting = smallestFactorWithinDimension(
      lo[axis],
      hi[axis],
      voxelOffset[axis],
      maxFactor[axis],
      maxTextureDim,
    );
    if (fitting === undefined) return undefined;
    factor[axis] = fitting;
  }

  let extent = extentForFactor(lo, hi, voxelOffset, factor);
  while (texelCount(extent) * PAINTED_VOLUME_BYTES_PER_TEXEL > budgetBytes) {
    const axis = nextAxisToDownsample(factor, maxFactor);
    if (axis === undefined) return undefined;
    factor[axis] *= 2;
    extent = extentForFactor(lo, hi, voxelOffset, factor);
  }
  return extent;
}

/** Largest power of two dividing `size`; `1` for odd or non-positive sizes. */
function largestPowerOfTwoDivisor(size: number): number {
  if (!Number.isInteger(size) || size <= 0) return 1;
  let divisor = 1;
  while (size % (divisor * 2) === 0) divisor *= 2;
  return divisor;
}

/** Smallest power-of-two factor (≤ `maxFactor`) whose texel count fits. */
function smallestFactorWithinDimension(
  lo: number,
  hi: number,
  offset: number,
  maxFactor: number,
  maxTextureDim: number,
): number | undefined {
  for (let factor = 1; factor <= maxFactor; factor *= 2) {
    const origin = alignDownToFactorGrid(lo, offset, factor);
    if (texelsCovering(origin, hi, factor) <= maxTextureDim) return factor;
  }
  return undefined;
}

/**
 * The axis to double next for the memory budget: the smaller of the x/y
 * factors that can still grow (x on a tie), else z, else none.
 */
function nextAxisToDownsample(
  factor: AxisTriple,
  maxFactor: readonly number[],
): number | undefined {
  const growable = [X, Y].filter((axis) => factor[axis] < maxFactor[axis]);
  if (growable.length > 0) {
    return growable.reduce((best, axis) =>
      factor[axis] < factor[best] ? axis : best,
    );
  }
  return factor[Z] < maxFactor[Z] ? Z : undefined;
}

function extentForFactor(
  lo: AxisTriple,
  hi: AxisTriple,
  voxelOffset: AxisTriple,
  factor: AxisTriple,
): PaintedVolumeExtent {
  const textureOrigin: [number, number, number] = [0, 0, 0];
  const textureSize: [number, number, number] = [0, 0, 0];
  for (const axis of [X, Y, Z]) {
    textureOrigin[axis] = alignDownToFactorGrid(
      lo[axis],
      voxelOffset[axis],
      factor[axis],
    );
    textureSize[axis] = texelsCovering(
      textureOrigin[axis],
      hi[axis],
      factor[axis],
    );
  }
  return {
    textureOrigin,
    factor: [factor[X], factor[Y], factor[Z]],
    textureSize,
  };
}

/** The factor-grid line (anchored at `offset`) at or below `voxel`. */
function alignDownToFactorGrid(
  voxel: number,
  offset: number,
  factor: number,
): number {
  return offset + Math.floor((voxel - offset) / factor) * factor;
}

/** Texels of `factor` voxels needed to reach the exclusive `hi` from `origin`. */
function texelsCovering(origin: number, hi: number, factor: number): number {
  return Math.ceil((hi - origin) / factor);
}

function texelCount(extent: PaintedVolumeExtent): number {
  const [sizeX, sizeY, sizeZ] = extent.textureSize;
  return sizeX * sizeY * sizeZ;
}
