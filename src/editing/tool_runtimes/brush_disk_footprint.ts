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
 * @file THE definition of the brush's shape: which voxels a stamp of a given
 * size covers, on the target layer's voxel lattice.
 *
 * Three consumers must agree on this exactly, or the cursor lies about where
 * paint will land: the main-thread rasterizers in `painting_compute.ts`, the
 * pyodide worker's `python_painter.py::_footprint_mask`, and the slice cursor's
 * fragment shader. So the shape lives here, once, and each consumer takes it
 * from the same three numbers — {@link brushStampAnchor},
 * {@link brushRadiusSquared}, {@link brushBoundsPadding}.
 *
 * THE SHAPE. Brush *size* is the diameter in voxels — any whole number ≥ 1. A
 * stamp covers every voxel whose centre lies within `size / 2` of the stamp
 * centre, and the stamp centre is placed so the footprint is symmetric:
 *
 *   - ODD size: on the centre of the voxel under the pointer. The footprint is
 *     symmetric about that voxel and `size` voxels across.
 *   - EVEN size: on the nearest voxel CORNER. There is no middle voxel to sit
 *     on — the footprint straddles the corner symmetrically, `size` voxels
 *     across.
 *
 * Either way the pointer only ever moves the footprint by whole voxels; the
 * shape itself never changes.
 *
 * WHY THE `+ 0.25`. Every rasterizer measures from a voxel's INDEX, not its
 * centre — `dx = voxelIndex - anchor`. Shifting the stamp centre by half a voxel
 * into that frame ({@link brushStampAnchor}) turns "voxel centre within R" into
 * "voxel index within R of the anchor", and the radius picks up the half-voxel:
 * `R² = radius² + 0.25`. That is what {@link brushRadiusSquared} returns, and it
 * is why an odd-size footprint is bit-identical to the old integer-radius rule
 * (`dx² + dy² ≤ radius²`): for integer `dx`, `dy`, and `radius`, `dx² + dy² ≤
 * radius² + 0.25` and `dx² + dy² ≤ radius²` have the same solutions.
 *
 * Sizes 1…8 cover 1, 4, 5, 12, 13, 24, 29, 44 voxels — monotonic, and every odd
 * size unchanged from before even sizes existed.
 */

/** Brush radius in voxels: `(size - 1) / 2`, so even sizes are half-integers. */
export type BrushRadius = number;

/**
 * The stamp centre, expressed in the voxel-INDEX frame the rasterizers measure
 * distances in (i.e. the true centre less half a voxel). Whole for an odd size,
 * half-way between voxels for an even one.
 *
 * `position` is a fractional target-voxel coordinate; the result depends only on
 * which voxel (odd) or which voxel boundary (even) it is nearest, so a pointer
 * moving inside one voxel never reshapes or nudges the footprint.
 *
 * Z is always the voxel under the pointer: the stamp is one voxel thick in Z at
 * every size.
 */
export function brushStampAnchor(
  position: readonly [number, number, number],
  radius: BrushRadius,
): [number, number, number] {
  // Even size → half-integer radius → anchor sits on a half-voxel.
  const halfShift = Number.isInteger(radius) ? 0 : 0.5;
  const anchor = (coordinate: number) =>
    Math.floor(coordinate + halfShift) - halfShift;
  return [anchor(position[0]), anchor(position[1]), Math.floor(position[2])];
}

/**
 * Squared radius for the `dx² + dy² ≤ R²` test, with `dx`/`dy` measured from
 * {@link brushStampAnchor} in voxel indices. See the file comment for the
 * `+ 0.25`.
 */
export function brushRadiusSquared(radius: BrushRadius): number {
  const clamped = brushRadius(radius);
  return clamped * clamped + 0.25;
}

/**
 * Padding, in whole voxels, that bounds the footprint around its anchor. Used to
 * size scan windows and mask buffers; a whole number because those are indexed
 * by voxel, and rounded UP so the window always contains the footprint.
 */
export function brushBoundsPadding(radius: BrushRadius): number {
  return Math.ceil(brushRadius(radius));
}

/** Sanitised radius: finite and non-negative. */
export function brushRadius(radius: BrushRadius): number {
  return Number.isFinite(radius) ? Math.max(0, radius) : 0;
}

/** Brush size (diameter in voxels) for a radius. */
export function brushSizeVoxels(radius: BrushRadius): number {
  return Math.round(2 * brushRadius(radius) + 1);
}

/**
 * Is the voxel at index offset (`offsetX`, `offsetY`, `offsetZ`) from the anchor
 * inside the footprint? The authoritative CPU statement of the shape;
 * {@link glsl_brushFootprintContains} is its GPU twin, and
 * `painting_compute.ts` applies the same test through `segmentDistanceSq`.
 *
 * Offsets are `voxelIndex - anchor`, so they are whole numbers for an odd size
 * and half-integers for an even one.
 */
export function brushFootprintContains(
  offsetX: number,
  offsetY: number,
  offsetZ: number,
  radiusSquared: number,
): boolean {
  if (offsetZ !== 0) return false;
  return offsetX * offsetX + offsetY * offsetY <= radiusSquared;
}

/**
 * GLSL twin of {@link brushFootprintContains}, for the slice cursor's fragment
 * shader. Kept beside the TypeScript version so the two statements of the shape
 * cannot drift; `brush_cursor_slice_overlay.browser_test.ts` asserts they agree
 * on real hardware.
 */
export const glsl_brushFootprintContains = `
bool footprintContains(vec3 voxelOffset, float radiusSquared) {
  if (voxelOffset.z != 0.0) return false;
  return dot(voxelOffset.xy, voxelOffset.xy) <= radiusSquared;
}
`;
