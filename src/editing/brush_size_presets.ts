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
 * The rungs the size slider and the `+` / `-` hotkeys step through — the ladder
 * the whole size UI is built on.
 *
 * Two regimes, because that is how brush size is actually used:
 *
 *   - **1–16: every single voxel.** Down here a voxel either side changes the
 *     stroke completely, and there is nothing finer to offer.
 *   - **Above 16: double.** `2^k + 1` — 17, 33, 65, 129, 257, 513, 1025. A big
 *     brush is chosen by order of magnitude, not by ±20%; the number box is
 *     there when an exact value in between is wanted.
 *
 * The slider advances one rung per step, so size grows exponentially along its
 * track — see `brushSizeStep`. Two thirds of the travel covers 1–16.
 */
export const BRUSH_SIZE_PRESETS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 33, 65, 129, 257,
  513, 1025,
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
 * the largest rung.
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

/** Highest valid slider position: one per rung of the preset ladder. */
export const MAX_BRUSH_SIZE_STEP = BRUSH_SIZE_PRESETS.length - 1;

/**
 * Slider position for `size` — its rung on {@link BRUSH_SIZE_PRESETS}.
 *
 * The ladder climbs geometrically, so a slider that moves one rung per step is
 * LOGARITHMIC in size: single-voxel granularity through 16, then doubling. A
 * linear slider gave the whole 1–16 range about 1.5% of its travel, which made
 * small brushes unpickable by drag; here they get two thirds of it.
 *
 * An off-ladder size (typed into the number box, which accepts any whole value)
 * reports its nearest rung — the same snapping the `+` / `-` hotkeys do.
 */
export function brushSizeStep(size: number): number {
  const step = BRUSH_SIZE_PRESETS.indexOf(nearestPresetSize(size));
  return step === -1 ? 0 : step;
}

/** Brush size at slider position `step`, clamped to the ladder's ends. */
export function brushSizeAtStep(step: number): number {
  if (!Number.isFinite(step)) return BRUSH_SIZE_PRESETS[0];
  const clamped = Math.max(0, Math.min(MAX_BRUSH_SIZE_STEP, Math.round(step)));
  return BRUSH_SIZE_PRESETS[clamped];
}
