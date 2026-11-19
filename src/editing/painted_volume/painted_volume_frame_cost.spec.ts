/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaintedVolumeFrameTimings } from "#src/editing/painted_volume/painted_volume_frame_cost.js";
import { PaintedVolumeFrameCost } from "#src/editing/painted_volume/painted_volume_frame_cost.js";
import { PaintedVolumeResolutionGovernor } from "#src/editing/painted_volume/painted_volume_resolution_governor.js";

const HALF = { reduction: 2, capSteps: false } as const;

/** A frame timer whose results the test hands out. */
function fakeTimings() {
  const finished: { frameNumber: number; frameDelta: number }[] = [];
  const timings = {
    frameNumber: 1,
    measuresFrameTimes: true,
    getLastFrameTimings: vi.fn((count: number) => finished.slice(-count)),
  };
  return {
    timings: timings as PaintedVolumeFrameTimings & typeof timings,
    finish: (frameNumber: number, frameDelta: number) =>
      finished.push({ frameNumber, frameDelta }),
  };
}

describe("PaintedVolumeFrameCost", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records the time of a frame the preview drew in, with that frame's resolution", async () => {
    const { timings, finish } = fakeTimings();
    const governor = new PaintedVolumeResolutionGovernor();
    const changed = vi.fn();
    const cost = new PaintedVolumeFrameCost(timings, governor, changed);
    timings.frameNumber = 7;
    cost.noteDraw(HALF, 1);
    await vi.advanceTimersByTimeAsync(50);
    expect(governor.hasMeasurement).toBe(false);
    // The result arrives later, between frames; nothing else draws.
    finish(7, 4);
    await vi.advanceTimersByTimeAsync(50);
    expect(governor.hasMeasurement).toBe(true);
    expect(cost.lastFrameMilliseconds).toBe(4);
    // 4 ms at half → 16 ms at full: the first measurement goes finer.
    expect(governor.resolution.reduction).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    cost.dispose();
  });

  it("ignores the times of frames the preview did not draw in", async () => {
    const { timings, finish } = fakeTimings();
    const governor = new PaintedVolumeResolutionGovernor();
    const cost = new PaintedVolumeFrameCost(timings, governor, () => {});
    timings.frameNumber = 3;
    cost.noteDraw(HALF, 1);
    finish(2, 900);
    finish(4, 900);
    await vi.advanceTimersByTimeAsync(100);
    expect(governor.hasMeasurement).toBe(false);
    cost.dispose();
  });

  it("stops polling once a frame's time never arrives", async () => {
    const { timings } = fakeTimings();
    const cost = new PaintedVolumeFrameCost(
      timings,
      new PaintedVolumeResolutionGovernor(),
      () => {},
    );
    cost.noteDraw(HALF, 1);
    await vi.advanceTimersByTimeAsync(11_000);
    const calls = timings.getLastFrameTimings.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timings.getLastFrameTimings.mock.calls.length).toBe(calls);
    cost.dispose();
  });
});
