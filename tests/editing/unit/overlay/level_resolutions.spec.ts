/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import { resolutionOfLevel } from "#src/editing/overlay/level_resolutions.js";

function levelWithScales(scaleX: number, scaleY: number) {
  const transform = new Float32Array(16);
  transform[0] = scaleX;
  transform[5] = scaleY;
  transform[10] = 1;
  transform[15] = 1;
  return {
    chunkToMultiscaleTransform: transform,
    chunkSource: { spec: { rank: 3, chunkDataSize: [64, 64, 16] } },
  };
}

describe("resolutionOfLevel", () => {
  it("a coarser level's voxel size is the model's times its scale", () => {
    expect(String(resolutionOfLevel(levelWithScales(2, 2), [16, 16, 40]))).toBe(
      String(resolutionOfLevel(levelWithScales(1, 1), [32, 32, 40])),
    );
  });

  it("a flipped axis has the same resolution and does not throw", () => {
    expect(() =>
      resolutionOfLevel(levelWithScales(-2, 2), [16, 16, 40]),
    ).not.toThrow();
    expect(
      String(resolutionOfLevel(levelWithScales(-2, 2), [16, 16, 40])),
    ).toBe(String(resolutionOfLevel(levelWithScales(2, 2), [16, 16, 40])));
  });
});
