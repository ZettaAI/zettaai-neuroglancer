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

import type { PaintedVolumePreviewSummary } from "#src/editing/painted_volume/painted_volume_preview_summary.js";
import { describePaintedVolumeToggle } from "#src/editing/painted_volume/painted_volume_toggle_description.js";

function live(
  overrides: Partial<Extract<PaintedVolumePreviewSummary, { kind: "live" }>>,
): PaintedVolumePreviewSummary {
  return {
    kind: "live",
    fill: { done: 4, total: 4, failed: 0 },
    textureBytes: 2 * 1024 * 1024,
    factor: [1, 1, 1],
    ...overrides,
  };
}

describe("describePaintedVolumeToggle", () => {
  it("offers to turn the preview on while off", () => {
    const description = describePaintedVolumeToggle({ kind: "off" });
    expect(description.pressed).toBe(false);
    expect(description.disabled).toBe(false);
    expect(description.downsampleLabel).toBeUndefined();
    expect(description.tooltip).toMatch(/^Show painted voxels in 3D/);
    expect(description.tooltip).toContain("3D panel");
    expect(description.tooltip).toContain(
      "selected segments and the brush segment",
    );
  });

  it("is pressed while waiting for the session tools", () => {
    const description = describePaintedVolumeToggle({ kind: "waiting" });
    expect(description.pressed).toBe(true);
    expect(description.disabled).toBe(false);
    expect(description.tooltip).toMatch(/^Hide painted voxels in 3D/);
  });

  it("names the texture size and the hints once live", () => {
    const description = describePaintedVolumeToggle(live({}));
    expect(description.pressed).toBe(true);
    expect(description.tooltip).toContain("Preview texture: 2.0 MiB");
    expect(description.tooltip).toContain("slices");
    expect(description.tooltip).toContain("meshes");
    expect(description.tooltip).not.toContain("Loading");
  });

  it("counts chunks while the region is loading", () => {
    const description = describePaintedVolumeToggle(
      live({ fill: { done: 3, total: 12, failed: 0 } }),
    );
    expect(description.tooltip).toContain("Loading 3 / 12 chunks");
  });

  it("reports chunks that could not be read", () => {
    const description = describePaintedVolumeToggle(
      live({ fill: { done: 12, total: 12, failed: 2 } }),
    );
    expect(description.tooltip).toContain("2 chunks could not be read");
  });

  it("labels a downsampled preview by its coarsest axis", () => {
    const description = describePaintedVolumeToggle(
      live({ factor: [2, 4, 1] }),
    );
    expect(description.downsampleLabel).toBe("×4");
    expect(description.tooltip).toContain("downsampled 2×4×1");
  });

  it("leaves a full-resolution preview unlabelled", () => {
    expect(describePaintedVolumeToggle(live({})).downsampleLabel).toBe(
      undefined,
    );
  });

  it.each([
    ["region-too-large", /too large/],
    ["texture-allocation-failed", /could not allocate/],
  ] as const)("disables the toggle with the %s reason", (reason, pattern) => {
    const description = describePaintedVolumeToggle({
      kind: "unavailable",
      reason,
    });
    expect(description.disabled).toBe(true);
    expect(description.pressed).toBe(false);
    expect(description.tooltip).toMatch(/^3D preview unavailable/);
    expect(description.tooltip).toMatch(pattern);
  });

  it("formats small textures in KiB", () => {
    expect(
      describePaintedVolumeToggle(live({ textureBytes: 64 * 1024 })).tooltip,
    ).toContain("Preview texture: 64 KiB");
  });
});
