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
 * @file Brush-cursor footprint geometry: which voxels the brush would write,
 * and how that voxel grid maps into the frame the view matrices consume.
 *
 * WHAT THE BRUSH ACTUALLY WRITES (`painting_compute.ts:stampDisk2D`): a disk in
 * TARGET voxel-index space on the X/Y plane, exactly one voxel thick in Z —
 * every voxel whose integer offset from the stamp center satisfies
 * `dx² + dy² ≤ r²`, where `r = floor(radius)` and the stamp center is
 * `floor(pointerVoxelPosition)`. The user-facing brush *size* is the diameter
 * (`size = 2 * radius + 1`, always odd), so the footprint is symmetric about
 * the center voxel and translates by whole voxels as the pointer moves — it
 * never changes shape.
 *
 * Two consequences drive everything here:
 *
 *   1. The footprint is quantized to the TARGET layer's voxel grid (the
 *      painting tool's target resolution), which is generally NOT the grid of
 *      the image layer being displayed. Anything drawn to represent it must be
 *      built on the target grid.
 *   2. On an anisotropic grid the physical/on-screen extent of the disk is an
 *      ELLIPSE, because the two in-plane voxel sizes differ.
 *
 * COORDINATE FRAMES. `projectionParameters.viewProjectionMat` consumes a
 * 3-vector whose component `slot` is the GLOBAL coordinate of
 * `displayDimensionIndices[slot]` (see `NavigationState.toMat4`, and
 * `slice_pixel_to_voxel.ts` which inverts exactly that). One global unit along
 * global dimension `d` therefore measures `coordinateSpace.scales[d]` — which
 * `DisplayDimensionRenderInfo` exposes per slot as `displayDimensionScales` /
 * `displayDimensionUnits`. (`voxelPhysicalScales` is a different quantity: it
 * folds in the user's relative display scales, which are already baked into the
 * view matrix, so using it here would double-apply them.)
 *
 * {@link resolveCursorVoxelFrame} bundles that mapping; converting between the
 * two frames is `globalToTargetVoxel` / `targetVoxelToGlobal`, the same helpers
 * the paint path uses — so the voxel index this module derives for the cursor
 * is bit-identical to the one the paint path writes.
 */

import { Resolution } from "@zettaai/edit-session";

import {
  globalToTargetVoxel,
  targetVoxelToGlobal,
} from "#src/editing/raster/global_voxel_conversion.js";
import { brushStampAnchor } from "#src/editing/tool_runtimes/brush_disk_footprint.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import { vec3 } from "#src/util/geom.js";

/**
 * The brush always stamps in the target layer's X/Y voxel plane at a fixed Z
 * (global dimensions 0 and 1). These are the two in-plane axes whose voxel
 * sizes define the ellipse semi-axes.
 */
const PAINTED_PLANE_GLOBAL_DIMS = [0, 1] as const;

/** Painting writes a 3-D voxel grid, so only global dims 0..2 can be mapped. */
const MAX_PAINTED_GLOBAL_DIM = 2;

/**
 * Voxel size assumed when the active tool has no target resolution yet
 * (detached state / tests). Degenerate, but keeps the math finite instead of
 * making the cursor vanish.
 */
const FALLBACK_VOXEL_SIZE_NM: readonly [number, number, number] = [1, 1, 1];

export interface BrushFootprintAxes {
  /** Display-space semi-axis vector for the painted plane's X axis (global dim 0). */
  readonly offsetX: vec3;
  /** Display-space semi-axis vector for the painted plane's Y axis (global dim 1). */
  readonly offsetY: vec3;
}

/**
 * How the target layer's voxel grid sits in the frame the view/projection
 * matrices consume. See the file comment for why the scales come from
 * `displayDimensionScales` rather than `voxelPhysicalScales`.
 */
export interface CursorVoxelFrame {
  /**
   * Global dimension rendered by each of the three display slots, or `-1` when
   * the slot is unused. A global dimension absent from this list is not part of
   * the view frame at all.
   */
  readonly globalDimForSlot: readonly [number, number, number];
  /**
   * Nanometres per unit of the viewer's GLOBAL coordinate space, per global
   * dimension. Entries for global dimensions that no slot renders are `0` and
   * must not be used.
   */
  readonly globalVoxelSizeNm: readonly [number, number, number];
  /** Nanometres per TARGET-resolution voxel, per global dimension. */
  readonly targetVoxelSizeNm: readonly [number, number, number];
}

/**
 * Visual radius of the painted footprint in voxels. The disk extends `radius`
 * voxels each side of the center voxel (diameter `2*radius + 1`), so the radius
 * that exactly bounds it is `radius + 0.5`. Matches the reference cursor's
 * `size/2` convention.
 */
export function visualRadiusVoxels(radiusVoxels: number): number {
  return radiusVoxels + 0.5;
}

/**
 * Nanometres per global-coordinate unit along the global dimension rendered by
 * `slot`, or `0` when unusable. Mirrors `EditSessionHost.globalVoxelSizeNm`,
 * which reads the same `coordinateSpace.scales` / `units` the paint path uses.
 */
function globalVoxelSizeNmForSlot(
  displayInfo: DisplayDimensionRenderInfo,
  slot: number,
): number {
  const scale = displayInfo.displayDimensionScales[slot];
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  return displayInfo.displayDimensionUnits[slot] === "m" ? scale * 1e9 : scale;
}

/**
 * Resolve the target voxel grid's placement in the current view frame.
 * Returns `undefined` when the footprint cannot be mapped: an unusable target
 * resolution or global scale, no displayed dimension at all, or a displayed
 * dimension outside the three global dimensions painting writes (painting is
 * 3-D, so a fourth displayed axis has no footprint to draw).
 */
export function resolveCursorVoxelFrame(
  resolution: Resolution | undefined,
  displayInfo: DisplayDimensionRenderInfo,
): CursorVoxelFrame | undefined {
  const targetVoxelSizeNm =
    resolution === undefined
      ? FALLBACK_VOXEL_SIZE_NM
      : Resolution.toVoxelSize(resolution);
  for (const nm of targetVoxelSizeNm) {
    if (!Number.isFinite(nm) || nm <= 0) return undefined;
  }

  const { displayDimensionIndices, displayRank } = displayInfo;
  const globalDimForSlot: [number, number, number] = [-1, -1, -1];
  const globalVoxelSizeNm: [number, number, number] = [0, 0, 0];
  let displayedCount = 0;
  for (let slot = 0; slot < 3 && slot < displayRank; ++slot) {
    const globalDim = displayDimensionIndices[slot];
    if (globalDim < 0) continue;
    if (globalDim > MAX_PAINTED_GLOBAL_DIM) return undefined;
    const globalNm = globalVoxelSizeNmForSlot(displayInfo, slot);
    if (globalNm === 0) return undefined;
    globalDimForSlot[slot] = globalDim;
    globalVoxelSizeNm[globalDim] = globalNm;
    ++displayedCount;
  }
  if (displayedCount === 0) return undefined;

  return {
    globalDimForSlot,
    globalVoxelSizeNm,
    targetVoxelSizeNm: [
      targetVoxelSizeNm[0],
      targetVoxelSizeNm[1],
      targetVoxelSizeNm[2],
    ],
  };
}

/**
 * Snap a pointer position to the stamp's centre, so cursor geometry sits on the
 * target voxel grid instead of sliding around inside a voxel as the pointer
 * moves.
 *
 * Which point that is depends on the brush size, so it comes from the shared
 * `brushStampAnchor`: the centre of a voxel for an odd size, a voxel BOUNDARY
 * for an even one. (The anchor lives in the voxel-index frame the distance test
 * measures in, which is half a voxel below the centre — hence the `+ 0.5`.)
 * Global dimensions the view does not render are passed through unchanged.
 */
export function snapWorldCenterToStampCenter(
  worldCenter: vec3,
  frame: CursorVoxelFrame,
  radiusVoxels: number,
): vec3 {
  const voxel = globalToTargetVoxel(
    [worldCenter[0], worldCenter[1], worldCenter[2]],
    frame.globalVoxelSizeNm,
    frame.targetVoxelSizeNm,
  );
  const anchor = brushStampAnchor(voxel, radiusVoxels);
  const snapped = targetVoxelToGlobal(
    [anchor[0] + 0.5, anchor[1] + 0.5, anchor[2] + 0.5],
    frame.globalVoxelSizeNm,
    frame.targetVoxelSizeNm,
  );
  const out = vec3.clone(worldCenter);
  for (const globalDim of frame.globalDimForSlot) {
    if (globalDim < 0) continue;
    out[globalDim] = snapped[globalDim];
  }
  return out;
}

/**
 * Compute the two painted-plane semi-axis vectors of the brush footprint, in
 * the frame `worldCenter` / `projectionParameters.viewProjectionMat` use.
 *
 * Each painted-plane global dimension (X = 0, Y = 1) is mapped to its display
 * axis slot. A dimension that is not currently rendered contributes a zero
 * vector — i.e. the disk is edge-on along that axis, which is physically
 * correct. The returned vectors collapse to zero length when the radius is
 * non-positive or the resolution / scale is unusable, letting callers skip
 * drawing.
 *
 * This is the smooth-ellipse approximation of the footprint, used by the 3-D
 * perspective cursor. The slice cursor draws the exact per-voxel footprint
 * instead (`painted_footprint_slice_quad.ts`).
 */
export function computeBrushFootprintAxes(
  radiusVoxels: number,
  resolution: Resolution | undefined,
  displayInfo: DisplayDimensionRenderInfo,
): BrushFootprintAxes {
  const offsets: vec3[] = [vec3.create(), vec3.create()];
  const axes = { offsetX: offsets[0], offsetY: offsets[1] };
  const radius = visualRadiusVoxels(radiusVoxels);
  if (!Number.isFinite(radius) || radius <= 0) return axes;
  const frame = resolveCursorVoxelFrame(resolution, displayInfo);
  if (frame === undefined) return axes;

  for (let axis = 0; axis < PAINTED_PLANE_GLOBAL_DIMS.length; ++axis) {
    const globalDim = PAINTED_PLANE_GLOBAL_DIMS[axis];
    const slot = frame.globalDimForSlot.indexOf(globalDim);
    if (slot < 0) continue; // dimension not displayed → edge-on, zero extent.
    // Global-frame length of `radius` voxels along this axis.
    offsets[axis][slot] =
      (radius * frame.targetVoxelSizeNm[globalDim]) /
      frame.globalVoxelSizeNm[globalDim];
  }

  return axes;
}
