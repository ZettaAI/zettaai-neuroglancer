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

import {
  PAINTED_VOLUME_EMERGENCY_MS,
  PAINTED_VOLUME_FRAME_BUDGET_MS,
  PAINTED_VOLUME_TRIAL_INTERVAL_MS,
  PaintedVolumeResolutionGovernor,
} from "#src/editing/painted_volume/painted_volume_resolution_governor.js";

const BUDGET = PAINTED_VOLUME_FRAME_BUDGET_MS;
const FULL = { reduction: 1, capSteps: false } as const;
const HALF = { reduction: 2, capSteps: false } as const;
const QUARTER = { reduction: 4, capSteps: false } as const;
const QUARTER_CAPPED = { reduction: 4, capSteps: true } as const;
/** Far apart enough that a trial is always allowed. */
const LATER = PAINTED_VOLUME_TRIAL_INTERVAL_MS;

type Resolution = { readonly reduction: 1 | 2 | 4; readonly capSteps: boolean };

/** Time of a frame at `resolution` that predicts `fullCost` at full. */
function frameAt(resolution: Resolution, fullCost: number): number {
  return fullCost / (resolution.reduction * resolution.reduction);
}

describe("PaintedVolumeResolutionGovernor", () => {
  /** Past its first measurement, settled at `resolution`, at time 0. */
  function settledAt(resolution: Resolution) {
    const governor = new PaintedVolumeResolutionGovernor();
    const fullCost = BUDGET * 0.9 * resolution.reduction * resolution.reduction;
    governor.record(frameAt(HALF, fullCost), HALF, 1, -LATER);
    governor.record(
      frameAt(governor.resolution, fullCost),
      governor.resolution,
      1,
      0,
    );
    expect(governor.resolution).toEqual(resolution);
    return governor;
  }

  it("starts at half resolution until a frame is measured", () => {
    const governor = new PaintedVolumeResolutionGovernor();
    expect(governor.resolution).toEqual(HALF);
    expect(governor.hasMeasurement).toBe(false);
  });

  it("goes to full resolution on the first frame when full is predicted within twice the budget", () => {
    const governor = new PaintedVolumeResolutionGovernor();
    expect(governor.record(frameAt(HALF, BUDGET * 1.8), HALF, 1, 0)).toBe(true);
    expect(governor.resolution).toEqual(FULL);
    expect(governor.hasMeasurement).toBe(true);
  });

  it("stays at half on the first frame when full is predicted past twice the budget", () => {
    const governor = new PaintedVolumeResolutionGovernor();
    expect(governor.record(frameAt(HALF, BUDGET * 3), HALF, 1, 0)).toBe(false);
    expect(governor.resolution).toEqual(HALF);
  });

  it("keeps full resolution while frames fit the budget", () => {
    const governor = settledAt(FULL);
    expect(governor.record(BUDGET * 0.95, FULL, 1, 1)).toBe(false);
    expect(governor.resolution).toEqual(FULL);
  });

  it("goes coarser at once when a frame is over budget", () => {
    const governor = settledAt(FULL);
    expect(governor.record(BUDGET * 2.4, FULL, 1, 1)).toBe(true);
    expect(governor.resolution).toEqual(HALF);
    expect(governor.record(frameAt(HALF, BUDGET * 6), HALF, 1, 2)).toBe(true);
    expect(governor.resolution).toEqual(QUARTER);
  });

  it("goes finer outright when the finer step is predicted under half the budget", () => {
    const governor = settledAt(HALF);
    expect(governor.record(frameAt(HALF, BUDGET * 0.4), HALF, 1, 1)).toBe(true);
    expect(governor.resolution).toEqual(FULL);
  });

  it("tries a finer step at most once per trial interval, and falls back from a failed one", () => {
    const governor = settledAt(HALF);
    // Full predicted at 1.5 budgets: within twice the budget, not surely
    // within it. A trial is due.
    const halfFrame = frameAt(HALF, BUDGET * 1.5);
    expect(governor.record(halfFrame, HALF, 1, LATER)).toBe(true);
    expect(governor.resolution).toEqual(FULL);
    // The trial frame is over budget: back to half.
    expect(governor.record(BUDGET * 1.5, FULL, 1, LATER + 50)).toBe(true);
    expect(governor.resolution).toEqual(HALF);
    // No new trial before the interval has passed.
    expect(governor.record(halfFrame, HALF, 1, LATER + 100)).toBe(false);
    expect(governor.resolution).toEqual(HALF);
    expect(governor.record(halfFrame, HALF, 1, LATER * 2 + 100)).toBe(true);
    expect(governor.resolution).toEqual(FULL);
  });

  it("does not try a finer step predicted past twice the budget", () => {
    const governor = settledAt(HALF);
    expect(governor.record(frameAt(HALF, BUDGET * 3), HALF, 1, LATER)).toBe(
      false,
    );
    expect(governor.resolution).toEqual(HALF);
  });

  it("caps the steps when even a quarter resolution is far over budget", () => {
    const governor = new PaintedVolumeResolutionGovernor();
    // 20 s at full (a software GPU, sparse strokes) → 1.25 s at a quarter.
    governor.record(5000, HALF, 1, 0);
    expect(governor.resolution).toEqual(QUARTER_CAPPED);
  });

  it("keeps the cap while the uncapped bound of a capped frame is unsafe", () => {
    const governor = new PaintedVolumeResolutionGovernor();
    governor.record(5000, HALF, 1, 0);
    // Capped to 1/24 of the steps: the uncapped frame could be 24× longer.
    const capped = (PAINTED_VOLUME_EMERGENCY_MS * 1.2) / 24;
    expect(governor.record(capped, QUARTER_CAPPED, 24, 1)).toBe(false);
    expect(governor.resolution).toEqual(QUARTER_CAPPED);
  });

  it("lifts the cap once even the uncapped bound is safe", () => {
    const governor = new PaintedVolumeResolutionGovernor();
    governor.record(5000, HALF, 1, 0);
    const capped = (BUDGET * 0.9) / 24;
    expect(governor.record(capped, QUARTER_CAPPED, 24, 1)).toBe(true);
    expect(governor.resolution).toEqual(QUARTER);
  });

  it("ignores measurements that are not a time", () => {
    const governor = new PaintedVolumeResolutionGovernor();
    expect(governor.record(Number.NaN, HALF, 1, 0)).toBe(false);
    expect(governor.record(-1, HALF, 1, 0)).toBe(false);
    expect(governor.hasMeasurement).toBe(false);
    expect(governor.resolution).toEqual(HALF);
  });
});
