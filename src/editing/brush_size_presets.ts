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
 * @file Brush size presets (TM-292).
 *
 * The user-facing brush parameter is *size* (a voxel count, always odd); the
 * library state stores *radius* (`size = radius * 2 + 1`). The `+` / `-`
 * hotkeys cycle through these preset sizes, and `EditSessionHost` seeds the
 * library's `radiusCycle` from them. This is the single source of truth —
 * the library's former `DEFAULT_RADIUS_CYCLE` export is being removed.
 */

/**
 * Preset brush sizes the `+` / `-` hotkeys step through. Roughly a +20%
 * geometric progression (sizes are odd voxel counts, so the low end steps by
 * the minimum +2 until 20% exceeds that granularity).
 */
export const BRUSH_SIZE_PRESETS: readonly number[] = [
  1, 3, 5, 7, 9, 11, 13, 17, 21, 25, 31, 37, 45, 55, 67, 81, 97, 117, 141, 169,
  203, 245, 295, 355, 427, 513, 617, 741, 889, 1025,
];

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 1025;

/**
 * Normalise a raw size to a valid brush size: a whole number of voxels, at least
 * {@link MIN_BRUSH_SIZE}. Non-finite input falls back to the minimum.
 *
 * Sizes used to be forced odd, because the radius was an integer and the disk had
 * to centre on a voxel. It no longer does: an even size anchors the stamp on a
 * voxel boundary instead (`brush_disk_footprint.ts`), so every whole size is a
 * real, symmetric footprint. There is no upper clamp — the number box may exceed
 * the largest preset.
 */
export function clampBrushSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_BRUSH_SIZE;
  return Math.max(MIN_BRUSH_SIZE, Math.round(value));
}

/**
 * The preset size closest to `value` (a raw, possibly-fractional voxel count).
 * Used to seed the brush from a continuous, zoom-derived target size so the
 * stored size is always one of the canonical presets the `+`/`-` hotkeys step
 * through. Ties go to the smaller preset; non-finite input falls back to the
 * first preset.
 */
export function nearestPresetSize(value: number): number {
  if (!Number.isFinite(value)) return BRUSH_SIZE_PRESETS[0];
  let best = BRUSH_SIZE_PRESETS[0];
  let bestDelta = Math.abs(value - best);
  for (const preset of BRUSH_SIZE_PRESETS) {
    const delta = Math.abs(value - preset);
    if (delta < bestDelta) {
      best = preset;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * size → radius (`radius = (size - 1) / 2`). A HALF-INTEGER for an even size —
 * see `brush_disk_footprint.ts`, which reads the fraction as "anchor the stamp on
 * a voxel boundary".
 */
export function sizeToRadius(size: number): number {
  return Math.max(0, (clampBrushSize(size) - 1) / 2);
}

/** radius → size (`size = radius * 2 + 1`). */
export function radiusToSize(radius: number): number {
  if (!Number.isFinite(radius)) return MIN_BRUSH_SIZE;
  return Math.max(MIN_BRUSH_SIZE, Math.round(2 * radius + 1));
}
