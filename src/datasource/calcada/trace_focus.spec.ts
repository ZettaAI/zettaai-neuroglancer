import { describe, expect, it } from "vitest";
import {
  canonicalDistance,
  framingZoom,
} from "#src/datasource/calcada/trace_focus.js";

// 16/16/45 nm: one step along z covers nearly three times the distance of one
// along x, and the canonical factors are what make the axes comparable.
const displayInfo = {
  displayRank: 3,
  displayDimensionIndices: Int32Array.of(0, 1, 2),
  canonicalVoxelFactors: Float64Array.of(1, 1, 45 / 16),
  canonicalVoxelPhysicalSize: 16e-9,
} as any;

describe("canonicalDistance", () => {
  it("measures a plain in-plane span", () => {
    expect(canonicalDistance([0, 0, 0], [3, 4, 0], displayInfo)).toBeCloseTo(
      5,
      9,
    );
  });

  it("weights depth by its physical size", () => {
    expect(canonicalDistance([0, 0, 0], [0, 0, 4], displayInfo)).toBeCloseTo(
      4 * (45 / 16),
      9,
    );
  });
});

describe("framingZoom", () => {
  it("leaves room around a wide pair", () => {
    const span = canonicalDistance([0, 0, 0], [400, 0, 0], displayInfo);
    expect(framingZoom([0, 0, 0], [400, 0, 0], displayInfo)).toBeGreaterThan(
      span,
    );
  });

  it("keeps a workable view when the endpoints coincide", () => {
    // 20 microns of volume across, not the sub-micron the span alone implies.
    expect(framingZoom([7, 7, 7], [7, 7, 7], displayInfo)).toBeCloseTo(
      20000 / 16,
      6,
    );
  });

  it("opens up beyond the floor for a wide pair", () => {
    // 2000 voxels of 16 nm is 32 microns; four times that beats the floor.
    expect(framingZoom([0, 0, 0], [2000, 0, 0], displayInfo)).toBeCloseTo(
      8000,
      6,
    );
  });
});
