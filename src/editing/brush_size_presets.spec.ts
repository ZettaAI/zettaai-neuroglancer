/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import {
  brushSizeAtStep,
  BRUSH_SIZE_PRESETS,
  brushSizeStep,
  MAX_BRUSH_SIZE,
  MAX_BRUSH_SIZE_STEP,
  MIN_BRUSH_SIZE,
  nearestPresetSize,
} from "#src/editing/brush_size_presets.js";

describe("brush size slider ladder", () => {
  it("round-trips every rung", () => {
    for (const [step, size] of BRUSH_SIZE_PRESETS.entries()) {
      expect(brushSizeStep(size), `size ${size}`).toBe(step);
      expect(brushSizeAtStep(step), `step ${step}`).toBe(size);
    }
    expect(MAX_BRUSH_SIZE_STEP).toBe(BRUSH_SIZE_PRESETS.length - 1);
  });

  it("is single-voxel granular through 17, then doubles", () => {
    // The point of the log scale: on a linear slider the whole 1–17 range sits
    // in ~1.5% of the travel, unpickable by drag. Here it is every single size
    // and two thirds of the rungs; above it, sizes double.
    const singleVoxelRange = BRUSH_SIZE_PRESETS.filter((s) => s <= 17);
    expect(singleVoxelRange).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    expect(singleVoxelRange.length / BRUSH_SIZE_PRESETS.length).toBeGreaterThan(
      0.6,
    );
    expect(BRUSH_SIZE_PRESETS.filter((s) => s > 17)).toEqual([
      33, 65, 129, 257, 513, 1025,
    ]);
  });

  it("never steps backwards and always reaches the maximum", () => {
    for (let step = 1; step <= MAX_BRUSH_SIZE_STEP; ++step) {
      expect(BRUSH_SIZE_PRESETS[step], `step ${step}`).toBeGreaterThan(
        BRUSH_SIZE_PRESETS[step - 1],
      );
    }
    expect(BRUSH_SIZE_PRESETS[0]).toBe(MIN_BRUSH_SIZE);
    expect(BRUSH_SIZE_PRESETS[MAX_BRUSH_SIZE_STEP]).toBe(MAX_BRUSH_SIZE);
  });

  it("snaps an off-ladder size to its nearest rung", () => {
    // 20 sits between rungs 17 and 33 — the number box can hold it, the slider
    // shows the nearest rung, as the +/- hotkeys do (`nearestPresetSize`).
    expect(brushSizeStep(20)).toBe(brushSizeStep(nearestPresetSize(20)));
    expect(brushSizeAtStep(brushSizeStep(20))).toBe(17);
    expect(brushSizeAtStep(brushSizeStep(28))).toBe(33);
  });

  it("clamps positions outside the ladder", () => {
    expect(brushSizeAtStep(-5)).toBe(BRUSH_SIZE_PRESETS[0]);
    expect(brushSizeAtStep(MAX_BRUSH_SIZE_STEP + 5)).toBe(
      BRUSH_SIZE_PRESETS[MAX_BRUSH_SIZE_STEP],
    );
    expect(brushSizeAtStep(Number.NaN)).toBe(BRUSH_SIZE_PRESETS[0]);
    // A size past the largest rung (the number box accepts them) pins to the end.
    expect(brushSizeStep(99999)).toBe(MAX_BRUSH_SIZE_STEP);
  });
});
