/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Resolution } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import { sizeToRadius } from "#src/editing/brush_size_presets.js";
import {
  computeBrushFootprintAxes,
  resolveCursorVoxelFrame,
  snapWorldCenterToStampCenter,
} from "#src/editing/cursor/brush_cursor_footprint.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import { vec3 } from "#src/util/geom.js";

// Minimal `DisplayDimensionRenderInfo` covering only the fields the footprint
// helper reads (`displayRank`, `displayDimensionIndices`,
// `displayDimensionScales`, `displayDimensionUnits`). Scales are per display
// slot, in metres — the same quantity `coordinateSpace.scales` holds, which is
// what the frame the view matrices consume is measured in.
function displayInfo(
  displayDimensionIndices: readonly number[],
  displayDimensionScales: readonly number[],
): DisplayDimensionRenderInfo {
  const displayRank = displayDimensionIndices.filter((i) => i >= 0).length;
  return {
    displayRank,
    displayDimensionIndices: Int32Array.from(displayDimensionIndices),
    displayDimensionScales: Float64Array.from(displayDimensionScales),
    displayDimensionUnits: displayDimensionIndices.map(() => "m"),
  } as unknown as DisplayDimensionRenderInfo;
}

// Identity XYZ display with 1 meter per global unit, so global-frame lengths
// equal `radiusVoxels × voxelSizeNm × 1e-9`.
const IDENTITY_XYZ = displayInfo([0, 1, 2], [1, 1, 1]);

describe("computeBrushFootprintAxes", () => {
  it("is a round cursor for isotropic in-plane voxels (64×64×42)", () => {
    const res = Resolution.from([64, 64, 42]);
    const { offsetX, offsetY } = computeBrushFootprintAxes(
      3,
      res,
      IDENTITY_XYZ,
    );
    // Each painted-plane axis maps to its own display slot.
    expect(offsetX[0]).toBeGreaterThan(0);
    expect(offsetY[1]).toBeGreaterThan(0);
    // Equal in-plane semi-axes → circle. (Was 66% wrong via Math.min picking z=42.)
    expect(offsetX[0] / offsetY[1]).toBeCloseTo(1, 6);
    // Visual radius = 3 + 0.5; 64 nm; 1 m/unit.
    expect(offsetX[0] / (3.5 * 64 * 1e-9)).toBeCloseTo(1, 6);
    // Off-axis components are zero.
    expect(offsetX[1]).toBe(0);
    expect(offsetX[2]).toBe(0);
    expect(offsetY[0]).toBe(0);
    expect(offsetY[2]).toBe(0);
  });

  it("is an ellipse for anisotropic in-plane voxels (56×432×16)", () => {
    const res = Resolution.from([56, 432, 16]);
    const { offsetX, offsetY } = computeBrushFootprintAxes(
      5,
      res,
      IDENTITY_XYZ,
    );
    // Semi-axis ratio mirrors the in-plane voxel-size ratio exactly.
    expect(offsetX[0] / offsetY[1]).toBeCloseTo(56 / 432, 6);
  });

  it("scales each axis by its global coordinate scale", () => {
    const res = Resolution.from([64, 64, 42]);
    // X display axis is 2× coarser (meters per unit) than Y → half the length.
    const info = displayInfo([0, 1, 2], [2e-9, 1e-9, 1e-9]);
    const { offsetX, offsetY } = computeBrushFootprintAxes(3, res, info);
    expect(offsetX[0] / offsetY[1]).toBeCloseTo(0.5, 6);
  });

  it("collapses an undisplayed painted-plane axis to zero (edge-on)", () => {
    const res = Resolution.from([64, 64, 42]);
    // XZ view: global dim 0 (X) and 2 (Z) displayed; dim 1 (Y) is not.
    const info = displayInfo([0, 2, -1], [1, 1, 1]);
    const { offsetX, offsetY } = computeBrushFootprintAxes(3, res, info);
    expect(offsetX[0]).toBeGreaterThan(0);
    expect(offsetY[0]).toBe(0);
    expect(offsetY[1]).toBe(0);
    expect(offsetY[2]).toBe(0);
  });

  it("defaults to isotropic 1 nm when resolution is undefined", () => {
    const { offsetX, offsetY } = computeBrushFootprintAxes(
      3,
      undefined,
      IDENTITY_XYZ,
    );
    expect(offsetX[0] / offsetY[1]).toBeCloseTo(1, 6);
    expect(offsetX[0] / (3.5 * 1 * 1e-9)).toBeCloseTo(1, 6);
  });

  it("returns zero vectors for non-positive / non-finite radius", () => {
    const res = Resolution.from([64, 64, 42]);
    for (const r of [-1, -0.5, Number.NaN]) {
      const { offsetX, offsetY } = computeBrushFootprintAxes(
        r,
        res,
        IDENTITY_XYZ,
      );
      expect(Array.from(offsetX)).toEqual([0, 0, 0]);
      expect(Array.from(offsetY)).toEqual([0, 0, 0]);
    }
  });
});

describe("resolveCursorVoxelFrame", () => {
  it("reports the target voxel size and the global unit size per axis", () => {
    // Global space at 4 nm, paint target at 32 nm.
    const info = displayInfo([0, 1, 2], [4e-9, 4e-9, 4e-9]);
    const frame = resolveCursorVoxelFrame(Resolution.from([32, 32, 32]), info);
    expect(frame).toBeDefined();
    expect(Array.from(frame!.globalDimForSlot)).toEqual([0, 1, 2]);
    for (const nm of frame!.globalVoxelSizeNm) expect(nm).toBeCloseTo(4, 9);
    expect(Array.from(frame!.targetVoxelSizeNm)).toEqual([32, 32, 32]);
  });

  it("marks an undisplayed global dimension as absent", () => {
    // XZ-only display: global dim 1 is not rendered.
    const info = displayInfo([0, 2, -1], [1, 1, 1]);
    const frame = resolveCursorVoxelFrame(Resolution.from([8, 8, 8]), info);
    expect(frame).toBeDefined();
    expect(Array.from(frame!.globalDimForSlot)).toEqual([0, 2, -1]);
    expect(frame!.globalVoxelSizeNm[1]).toBe(0);
  });

  it("declines a displayed dimension outside the painted volume", () => {
    // A fourth global dimension (e.g. time) on screen: no footprint to draw.
    const info = displayInfo([0, 1, 3], [1, 1, 1]);
    expect(
      resolveCursorVoxelFrame(Resolution.from([8, 8, 8]), info),
    ).toBeUndefined();
  });

  it("declines an unusable global scale", () => {
    const info = displayInfo([0, 1, 2], [1, 0, 1]);
    expect(
      resolveCursorVoxelFrame(Resolution.from([8, 8, 8]), info),
    ).toBeUndefined();
  });
});

describe("snapWorldCenterToStampCenter", () => {
  // Global space at 4 nm; target voxels at 16 nm → 4 global units per voxel.
  const info = displayInfo([0, 1, 2], [4e-9, 4e-9, 4e-9]);
  const frame = resolveCursorVoxelFrame(Resolution.from([16, 16, 16]), info)!;
  // Voxel 102 spans [408, 412) global units: centre 410, boundaries 408 / 412.
  const oddRadius = sizeToRadius(5);
  const evenRadius = sizeToRadius(4);

  it("snaps an odd size to the centre of the pointer's voxel", () => {
    const snapped = snapWorldCenterToStampCenter(
      vec3.fromValues(409, 5, 1),
      frame,
      oddRadius,
    );
    expect(snapped[0]).toBeCloseTo(410, 9);
    expect(snapped[1]).toBeCloseTo(6, 9);
    expect(snapped[2]).toBeCloseTo(2, 9);
    // Every position inside the voxel snaps to the same point.
    expect(
      Array.from(
        snapWorldCenterToStampCenter(
          vec3.fromValues(411.9, 7.9, 3.9),
          frame,
          oddRadius,
        ),
      ),
    ).toEqual(Array.from(snapped));
  });

  it("snaps an even size to the nearest voxel BOUNDARY", () => {
    // An even size has no middle voxel to sit on. Below the voxel's midpoint
    // (410) the nearest boundary is 408; above it, 412.
    expect(
      snapWorldCenterToStampCenter(
        vec3.fromValues(409, 5, 1),
        frame,
        evenRadius,
      )[0],
    ).toBeCloseTo(408, 9);
    expect(
      snapWorldCenterToStampCenter(
        vec3.fromValues(411, 5, 1),
        frame,
        evenRadius,
      )[0],
    ).toBeCloseTo(412, 9);
  });

  it("leaves undisplayed dimensions untouched", () => {
    const xzInfo = displayInfo([0, 2, -1], [4e-9, 4e-9, 4e-9]);
    const xzFrame = resolveCursorVoxelFrame(
      Resolution.from([16, 16, 16]),
      xzInfo,
    )!;
    const snapped = snapWorldCenterToStampCenter(
      vec3.fromValues(410, 123.456, 0),
      xzFrame,
      oddRadius,
    );
    expect(snapped[0]).toBeCloseTo(410, 9);
    // `vec3` is a Float32Array, so the passed-through value is the float32 of
    // the input, not a snapped one.
    expect(snapped[1]).toBeCloseTo(123.456, 4);
    expect(snapped[2]).toBeCloseTo(2, 9);
  });
});
