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

import type { PaintedVolumePreviewStatus } from "#src/editing/painted_volume/painted_volume_preview.js";
import { summarizePaintedVolumePreviews } from "#src/editing/painted_volume/painted_volume_preview_summary.js";

function live(
  done: number,
  total: number,
  options: {
    failed?: number;
    textureBytes?: number;
    factor?: [number, number, number];
  } = {},
): PaintedVolumePreviewStatus {
  return {
    kind: "live",
    fill: { done, total, failed: options.failed ?? 0 },
    textureBytes: options.textureBytes ?? 1024,
    factor: options.factor ?? [1, 1, 1],
  };
}

describe("summarizePaintedVolumePreviews", () => {
  it("is off while the toggle is off, whatever previews linger", () => {
    expect(summarizePaintedVolumePreviews(false, [live(1, 4)])).toEqual({
      kind: "off",
    });
  });

  it("waits while enabled with nothing built yet", () => {
    expect(summarizePaintedVolumePreviews(true, [])).toEqual({
      kind: "waiting",
    });
  });

  it("passes one live preview through", () => {
    expect(
      summarizePaintedVolumePreviews(true, [
        live(2, 8, { textureBytes: 4096, factor: [2, 2, 1] }),
      ]),
    ).toEqual({
      kind: "live",
      fill: { done: 2, total: 8, failed: 0 },
      textureBytes: 4096,
      factor: [2, 2, 1],
    });
  });

  it("sums fill and texture bytes across layers and keeps the coarsest factor per axis", () => {
    expect(
      summarizePaintedVolumePreviews(true, [
        live(1, 4, { failed: 1, textureBytes: 100, factor: [2, 1, 1] }),
        live(3, 6, { textureBytes: 50, factor: [1, 4, 1] }),
      ]),
    ).toEqual({
      kind: "live",
      fill: { done: 4, total: 10, failed: 1 },
      textureBytes: 150,
      factor: [2, 4, 1],
    });
  });

  it("reports the first unavailable preview over any live one", () => {
    expect(
      summarizePaintedVolumePreviews(true, [
        live(1, 1),
        { kind: "unavailable", reason: "texture-allocation-failed" },
        { kind: "unavailable", reason: "region-too-large" },
      ]),
    ).toEqual({ kind: "unavailable", reason: "texture-allocation-failed" });
  });
});
