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
 * @file Where the view goes when a candidate comes up for review.
 *
 * Recentring alone is not enough: a candidate is a contact between two
 * segments, and at a zoom that fits a whole neuron the pair is a few pixels of
 * nothing. The point of the jump is to arrive already able to judge it.
 */

import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";

/**
 * How many times the candidate's own span should be visible around it. At 1 the
 * pair fills the viewport edge to edge, cutting off exactly the context the
 * judgement needs.
 */
const FRAMING_MARGIN = 4;

/**
 * Never zoom closer than this much of the volume across.
 *
 * Stated in nanometres, like the sphere radius, because canonical voxels say
 * nothing about how close that actually is: the first version of this floor was
 * 64 canonical voxels, which on a 16 nm grid is about one micron across — well
 * inside the mesh. Most contacts are sub-micron, so the floor, not the span, is
 * what decides the zoom for the majority of candidates.
 */
const MIN_FRAMING_EXTENT_NM = 20000;

/**
 * Distance between two global-coordinate points, in the canonical voxels the
 * zoom is measured in.
 *
 * `canonicalVoxelFactors` is what makes the axes comparable: on a 16/16/45 grid
 * a step of one along z is nearly three times the distance of a step along x,
 * and a plain Euclidean distance over raw coordinates would frame a deep pair
 * far too tightly.
 */
export function canonicalDistance(
  pointA: ArrayLike<number>,
  pointB: ArrayLike<number>,
  displayInfo: DisplayDimensionRenderInfo,
): number {
  const { displayDimensionIndices, canonicalVoxelFactors, displayRank } =
    displayInfo;
  let total = 0;
  for (let slot = 0; slot < displayRank && slot < 3; ++slot) {
    const dim = displayDimensionIndices[slot];
    if (dim < 0) continue;
    const delta = (pointA[dim] - pointB[dim]) * canonicalVoxelFactors[slot];
    total += delta * delta;
  }
  return Math.sqrt(total);
}

/** The zoom that frames a candidate's two endpoints with room to spare. */
export function framingZoom(
  pointA: ArrayLike<number>,
  pointB: ArrayLike<number>,
  displayInfo: DisplayDimensionRenderInfo,
): number {
  const span = canonicalDistance(pointA, pointB, displayInfo);
  return Math.max(minFramingExtent(displayInfo), span * FRAMING_MARGIN);
}

/** MIN_FRAMING_EXTENT_NM expressed in the canonical voxels the zoom uses. */
function minFramingExtent(displayInfo: DisplayDimensionRenderInfo): number {
  // canonicalVoxelPhysicalSize is SI, so metres per canonical voxel.
  const nmPerCanonicalVoxel = displayInfo.canonicalVoxelPhysicalSize * 1e9;
  if (!Number.isFinite(nmPerCanonicalVoxel) || nmPerCanonicalVoxel <= 0) {
    return 0;
  }
  return MIN_FRAMING_EXTENT_NM / nmPerCanonicalVoxel;
}
