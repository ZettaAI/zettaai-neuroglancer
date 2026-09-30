/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file The screen quad the slice cursor rasterizes the painted footprint into.
 *
 * The slice cursor must trace the exact voxel footprint the brush would write
 * (`brush_cursor_footprint.ts`), staircase edges and all, on the TARGET layer's
 * voxel grid — in every slice orientation, including the XZ / YZ orthogonal
 * views where the one-voxel-thick painted slab is seen edge-on.
 *
 * Rather than tessellate that staircase on the CPU (vertex count grows with the
 * brush radius, and the cross-section shape depends on the slice orientation),
 * we hand the fragment shader the footprint's *definition* and let it test each
 * fragment for membership. This module supplies the geometry that makes that
 * possible:
 *
 *   - A screen-aligned quad in NDC, sized to the footprint's projected bounding
 *     box plus an outline margin, so the fragment pass costs only the pixels the
 *     cursor could possibly cover.
 *   - Per-corner positions in TARGET voxel units, relative to the lower corner
 *     of the stamp's center voxel. A slice view's projection is orthographic —
 *     hence affine — so interpolating those four values across the quad gives
 *     every fragment its exact voxel coordinate on the slice plane, in any
 *     orientation (axis-aligned, rotated, or oblique).
 *
 * Two details keep the interpolated offsets trustworthy:
 *
 *   - They are relative to the center voxel, not absolute. Absolute voxel
 *     coordinates in a large volume exhaust float32's precision long before the
 *     fragment shader can floor them reliably.
 *   - Each corner's offset is built as `fractionalCenterOffset + (corner −
 *     center)`, both terms measured through the same inverse projection. The
 *     constant term is then exactly the pointer's position inside its own voxel
 *     — in `[0, 1)` by construction — so an axis that is constant across the
 *     quad (the slice normal in an axis-aligned view) can never floor to the
 *     neighbouring voxel and blank the cursor out.
 *
 * The NDC z of 0 is the slice plane itself — the same plane
 * `slice_pixel_to_voxel.ts` inverts pointer pixels onto.
 */

import type { CursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import {
  globalToTargetVoxel,
  targetVoxelToGlobal,
} from "#src/editing/raster/global_voxel_conversion.js";
import {
  brushBoundsPadding,
  brushStampAnchor,
} from "#src/editing/tool_runtimes/brush_disk_footprint.js";
import type { mat4 } from "#src/util/geom.js";
import { vec3 } from "#src/util/geom.js";

/** Quad corners, in `gl.TRIANGLE_STRIP` order. */
const CORNER_COUNT = 4;

/** Corners of the footprint's axis-aligned voxel bounding box. */
const BOUNDS_CORNER_COUNT = 8;

export interface PaintedFootprintSliceQuad {
  /** NDC `(x, y)` per corner — `CORNER_COUNT * 2` floats. */
  readonly cornersNdc: Float32Array;
  /**
   * Per-corner position in target voxel units, relative to the lower corner of
   * the center voxel — `CORNER_COUNT * 3` floats, one `vec3` per corner.
   */
  readonly cornerVoxelOffsets: Float32Array;
  /**
   * The stamp anchor in the same frame as `cornerVoxelOffsets` (X and Y only —
   * the stamp is one voxel thick in Z at every size, so Z needs no anchor).
   * Zero for an odd brush size, half a voxel for an even one, where the footprint
   * straddles a voxel boundary instead of centring on a voxel.
   */
  readonly anchorOffset: readonly [number, number];
}

export interface PaintedFootprintSliceQuadInput {
  /** Brush radius in target voxels, `(size - 1) / 2` (half-integer if even). */
  readonly radiusVoxels: number;
  /** Pointer position in the viewer's global coordinate space. */
  readonly worldCenter: vec3;
  readonly frame: CursorVoxelFrame;
  readonly viewProjectionMat: mat4;
  readonly invViewProjectionMat: mat4;
  /** Viewport size in pixels, used to convert the outline margin into NDC. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /**
   * Pixels of slack around the footprint's projected bounds. The outline
   * straddles the footprint boundary, so its outer half falls on fragments that
   * are outside the painted set and would otherwise be clipped away.
   */
  readonly marginPixels: number;
}

type Triple = [number, number, number];

/**
 * Smallest distance, in voxels, the pointer is held away from its own voxel's
 * faces. Along an axis-aligned view's slice normal the corner offsets differ from
 * the pointer's fraction only by matrix round-off, so a pointer sitting exactly
 * on a voxel boundary (fraction 0) could floor a hair below it and put every
 * fragment in the neighbouring voxel — blanking the cursor. A nudge of 1e-4 voxel
 * is far below one screen pixel at any usable zoom, and far above the round-off.
 */
const VOXEL_INTERIOR_MARGIN = 1e-4;

/** Hold a voxel-interior fraction strictly inside `(0, 1)`. */
function voxelInteriorFraction(fraction: number): number {
  return Math.min(
    1 - VOXEL_INTERIOR_MARGIN,
    Math.max(VOXEL_INTERIOR_MARGIN, fraction),
  );
}

const scratchSlotPosition = vec3.create();
const scratchProjected = vec3.create();

/**
 * Project a global-coordinate position to NDC. The view/projection matrices
 * consume a 3-vector whose component `slot` is the global coordinate of
 * `globalDimForSlot[slot]`; slots with no global dimension contribute 0 (they
 * scale nothing in the matrix).
 */
function projectGlobalPositionToNdc(
  globalPosition: readonly [number, number, number],
  globalDimForSlot: readonly [number, number, number],
  viewProjectionMat: mat4,
): { ndcX: number; ndcY: number } {
  for (let slot = 0; slot < 3; ++slot) {
    const globalDim = globalDimForSlot[slot];
    scratchSlotPosition[slot] = globalDim < 0 ? 0 : globalPosition[globalDim];
  }
  vec3.transformMat4(scratchProjected, scratchSlotPosition, viewProjectionMat);
  return { ndcX: scratchProjected[0], ndcY: scratchProjected[1] };
}

/**
 * Target voxel coordinate of the slice-plane point under an NDC position.
 * Global dimensions the view does not render yield 0 — they are constant across
 * the plane, so they cancel out of the corner-minus-center difference.
 */
function voxelCoordAtNdc(
  input: PaintedFootprintSliceQuadInput,
  ndcX: number,
  ndcY: number,
): Triple {
  const { frame, invViewProjectionMat } = input;
  vec3.set(scratchSlotPosition, ndcX, ndcY, 0);
  vec3.transformMat4(
    scratchProjected,
    scratchSlotPosition,
    invViewProjectionMat,
  );
  const globalPosition: Triple = [0, 0, 0];
  for (let slot = 0; slot < 3; ++slot) {
    const globalDim = frame.globalDimForSlot[slot];
    if (globalDim < 0) continue;
    globalPosition[globalDim] = scratchProjected[slot];
  }
  return globalToTargetVoxel(
    globalPosition,
    frame.globalVoxelSizeNm,
    frame.targetVoxelSizeNm,
  );
}

/**
 * NDC bounds of the footprint's voxel bounding box: the disk reaches
 * `brushBoundsPadding` voxels each side of the anchor in X and Y, and the stamp
 * is exactly one voxel thick in Z. Projecting all eight corners bounds the
 * cross-section for any slice orientation. Returns `undefined` when a corner
 * fails to project.
 */
function projectFootprintBoundsToNdc(
  input: PaintedFootprintSliceQuadInput,
  centerVoxel: Triple,
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  const { frame, radiusVoxels, viewProjectionMat } = input;
  // One voxel of slack beyond the brush's whole-voxel reach, so an even size's
  // half-voxel anchor offset cannot push the footprint outside the box.
  const padding = brushBoundsPadding(radiusVoxels) + 1;
  const lo: Triple = [-padding, -padding, 0];
  const hi: Triple = [padding + 1, padding + 1, 1];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < BOUNDS_CORNER_COUNT; ++corner) {
    const voxel: Triple = [0, 0, 0];
    for (let globalDim = 0; globalDim < 3; ++globalDim) {
      const atUpperBound = (corner & (1 << globalDim)) !== 0;
      voxel[globalDim] =
        centerVoxel[globalDim] + (atUpperBound ? hi[globalDim] : lo[globalDim]);
    }
    const globalPosition = targetVoxelToGlobal(
      voxel,
      frame.globalVoxelSizeNm,
      frame.targetVoxelSizeNm,
    );
    const { ndcX, ndcY } = projectGlobalPositionToNdc(
      globalPosition,
      frame.globalDimForSlot,
      viewProjectionMat,
    );
    if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return undefined;
    minX = Math.min(minX, ndcX);
    maxX = Math.max(maxX, ndcX);
    minY = Math.min(minY, ndcY);
    maxY = Math.max(maxY, ndcY);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Build the screen quad that covers the painted footprint's cross-section on
 * the current slice plane, together with each corner's voxel offset.
 *
 * Returns `undefined` when there is nothing to draw: the footprint projects to
 * nothing finite, or its bounds fall entirely outside the viewport.
 */
export function computePaintedFootprintSliceQuad(
  input: PaintedFootprintSliceQuadInput,
): PaintedFootprintSliceQuad | undefined {
  const {
    frame,
    worldCenter,
    viewProjectionMat,
    viewportWidth,
    viewportHeight,
    marginPixels,
  } = input;
  if (viewportWidth <= 0 || viewportHeight <= 0) return undefined;

  const centerVoxelCoord = globalToTargetVoxel(
    [worldCenter[0], worldCenter[1], worldCenter[2]],
    frame.globalVoxelSizeNm,
    frame.targetVoxelSizeNm,
  );
  const centerVoxel: Triple = [
    Math.floor(centerVoxelCoord[0]),
    Math.floor(centerVoxelCoord[1]),
    Math.floor(centerVoxelCoord[2]),
  ];
  if (centerVoxel.some((voxel) => !Number.isFinite(voxel))) return undefined;
  // Where the pointer sits inside its own voxel; in [0, 1) by construction.
  const centerFraction: Triple = [
    voxelInteriorFraction(centerVoxelCoord[0] - centerVoxel[0]),
    voxelInteriorFraction(centerVoxelCoord[1] - centerVoxel[1]),
    voxelInteriorFraction(centerVoxelCoord[2] - centerVoxel[2]),
  ];

  const bounds = projectFootprintBoundsToNdc(input, centerVoxel);
  if (bounds === undefined) return undefined;

  // NDC spans [-1, 1] across each viewport dimension, so one pixel is
  // `2 / dimension` NDC units.
  const marginNdcX = (2 * marginPixels) / viewportWidth;
  const marginNdcY = (2 * marginPixels) / viewportHeight;
  const minX = Math.max(-1, bounds.minX - marginNdcX);
  const maxX = Math.min(1, bounds.maxX + marginNdcX);
  const minY = Math.max(-1, bounds.minY - marginNdcY);
  const maxY = Math.min(1, bounds.maxY + marginNdcY);
  if (minX >= maxX || minY >= maxY) return undefined; // fully off-screen.

  const centerNdc = projectGlobalPositionToNdc(
    [worldCenter[0], worldCenter[1], worldCenter[2]],
    frame.globalDimForSlot,
    viewProjectionMat,
  );
  const voxelAtCenterNdc = voxelCoordAtNdc(
    input,
    centerNdc.ndcX,
    centerNdc.ndcY,
  );

  const cornersNdc = new Float32Array(CORNER_COUNT * 2);
  const cornerVoxelOffsets = new Float32Array(CORNER_COUNT * 3);
  // Triangle-strip order: (min, min), (max, min), (min, max), (max, max).
  const cornerX = [minX, maxX, minX, maxX];
  const cornerY = [minY, minY, maxY, maxY];
  for (let corner = 0; corner < CORNER_COUNT; ++corner) {
    cornersNdc[corner * 2 + 0] = cornerX[corner];
    cornersNdc[corner * 2 + 1] = cornerY[corner];
    const voxelAtCorner = voxelCoordAtNdc(
      input,
      cornerX[corner],
      cornerY[corner],
    );
    for (let globalDim = 0; globalDim < 3; ++globalDim) {
      cornerVoxelOffsets[corner * 3 + globalDim] =
        centerFraction[globalDim] +
        (voxelAtCorner[globalDim] - voxelAtCenterNdc[globalDim]);
    }
  }
  // The anchor, in the corner-offset frame (origin = the center voxel's lower
  // corner). `brushStampAnchor` works in absolute voxel coordinates, so subtract
  // the origin to land in the same frame the shader interpolates.
  const anchor = brushStampAnchor(centerVoxelCoord, input.radiusVoxels);
  return {
    cornersNdc,
    cornerVoxelOffsets,
    anchorOffset: [anchor[0] - centerVoxel[0], anchor[1] - centerVoxel[1]],
  };
}
