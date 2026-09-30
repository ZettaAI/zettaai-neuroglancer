/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Resolution } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import type { CursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import { resolveCursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { PaintedFootprintSliceQuad } from "#src/editing/cursor/painted_footprint_slice_quad.js";
import { computePaintedFootprintSliceQuad } from "#src/editing/cursor/painted_footprint_slice_quad.js";
import { targetVoxelToGlobal } from "#src/editing/raster/global_voxel_conversion.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import { mat4, quat, vec3 } from "#src/util/geom.js";

const VIEWPORT_WIDTH = 400;
const VIEWPORT_HEIGHT = 300;
const MARGIN_PIXELS = 2;

// A realistically scaled harness: the viewer's global coordinate space is at
// 4 nm, the paint target is a coarser scale, and one screen pixel is one global
// unit. Keeping every quantity near unity keeps the matrix round-trips well
// conditioned, so the assertions below test the geometry rather than float noise.
const GLOBAL_VOXEL_SIZE_NM = 4;
const DEFAULT_TARGET_VOXEL_SIZE_NM = [16, 16, 16] as const;
const GLOBAL_UNITS_PER_PIXEL = 1;

function displayInfo(): DisplayDimensionRenderInfo {
  const scaleMeters = GLOBAL_VOXEL_SIZE_NM * 1e-9;
  return {
    displayRank: 3,
    displayDimensionIndices: Int32Array.from([0, 1, 2]),
    displayDimensionScales: Float64Array.from([
      scaleMeters,
      scaleMeters,
      scaleMeters,
    ]),
    displayDimensionUnits: ["m", "m", "m"],
  } as unknown as DisplayDimensionRenderInfo;
}

/** Screen pixels spanned by one target voxel along an axis. */
function pixelsPerVoxel(targetVoxelSizeNm: number): number {
  return targetVoxelSizeNm / GLOBAL_VOXEL_SIZE_NM / GLOBAL_UNITS_PER_PIXEL;
}

/** Slice-view orientations, as the view rotation the navigation pose applies. */
const ORIENTATIONS = {
  /** Screen X → global X, screen Y → global Y; slice normal is global Z. */
  xy: quat.create(),
  /** 90° about X: screen Y → global Z; slice normal is global Y. */
  xz: quat.setAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2),
  /** 90° about Y: screen X → global Z; slice normal is global X. */
  yz: quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2),
};

interface SliceProjection {
  readonly viewProjectionMat: mat4;
  readonly invViewProjectionMat: mat4;
}

/**
 * Build a slice panel's view/projection pair the way
 * `SliceViewRenderHelper`'s `DerivedProjectionParameters` does: the inverse view
 * matrix is the navigation pose (rotation, scaled by the zoom, translated to the
 * viewport center), and the projection is orthographic over the viewport.
 * `globalUnitsPerViewUnit` stands in for zoom / canonicalVoxelFactors.
 */
function sliceProjection(
  orientation: quat,
  viewportCenterGlobal: readonly [number, number, number],
  globalUnitsPerViewUnit: number,
): SliceProjection {
  const invViewMatrix = mat4.fromQuat(mat4.create(), orientation);
  for (let row = 0; row < 3; ++row) {
    invViewMatrix[row] *= globalUnitsPerViewUnit;
    invViewMatrix[4 + row] *= globalUnitsPerViewUnit;
    invViewMatrix[8 + row] *= globalUnitsPerViewUnit;
    invViewMatrix[12 + row] = viewportCenterGlobal[row];
  }
  const viewMatrix = mat4.invert(mat4.create(), invViewMatrix)!;
  const projectionMat = mat4.ortho(
    mat4.create(),
    -VIEWPORT_WIDTH / 2,
    VIEWPORT_WIDTH / 2,
    VIEWPORT_HEIGHT / 2,
    -VIEWPORT_HEIGHT / 2,
    -1000,
    1000,
  );
  const viewProjectionMat = mat4.multiply(
    mat4.create(),
    projectionMat,
    viewMatrix,
  );
  return {
    viewProjectionMat,
    invViewProjectionMat: mat4.invert(mat4.create(), viewProjectionMat)!,
  };
}

function cursorFrame(voxelSizeNm: readonly [number, number, number]) {
  const frame = resolveCursorVoxelFrame(
    Resolution.from([voxelSizeNm[0], voxelSizeNm[1], voxelSizeNm[2]]),
    displayInfo(),
  );
  expect(frame).toBeDefined();
  return frame as CursorVoxelFrame;
}

/** Global position of a target-voxel coordinate (may be fractional). */
function voxelToGlobal(
  frame: CursorVoxelFrame,
  voxel: readonly [number, number, number],
): [number, number, number] {
  return targetVoxelToGlobal(
    [voxel[0], voxel[1], voxel[2]],
    frame.globalVoxelSizeNm,
    frame.targetVoxelSizeNm,
  );
}

function projectToNdc(
  projection: SliceProjection,
  globalPosition: readonly [number, number, number],
): [number, number] {
  const out = vec3.transformMat4(
    vec3.create(),
    vec3.fromValues(globalPosition[0], globalPosition[1], globalPosition[2]),
    projection.viewProjectionMat,
  );
  return [out[0], out[1]];
}

/**
 * Bilinearly interpolate the quad's per-corner voxel offsets at an NDC point —
 * exactly what the rasterizer hands the fragment shader as `vVoxelOffset`. The
 * corners are `(min, min), (max, min), (min, max), (max, max)` in NDC.
 */
function interpolateVoxelOffset(
  quad: PaintedFootprintSliceQuad,
  ndcX: number,
  ndcY: number,
): [number, number, number] {
  const { cornersNdc, cornerVoxelOffsets } = quad;
  const minX = cornersNdc[0];
  const minY = cornersNdc[1];
  const maxX = cornersNdc[2];
  const maxY = cornersNdc[5];
  const fractionX = (ndcX - minX) / (maxX - minX);
  const fractionY = (ndcY - minY) / (maxY - minY);
  const weights = [
    (1 - fractionX) * (1 - fractionY),
    fractionX * (1 - fractionY),
    (1 - fractionX) * fractionY,
    fractionX * fractionY,
  ];
  const offset: [number, number, number] = [0, 0, 0];
  for (let corner = 0; corner < 4; ++corner) {
    for (let axis = 0; axis < 3; ++axis) {
      offset[axis] += weights[corner] * cornerVoxelOffsets[corner * 3 + axis];
    }
  }
  return offset;
}

interface QuadCase {
  readonly quad: PaintedFootprintSliceQuad;
  readonly frame: CursorVoxelFrame;
  readonly projection: SliceProjection;
}

function buildQuad(options: {
  orientation: quat;
  paintedRadius: number;
  /** Pointer position in target voxel coordinates (may be fractional). */
  pointerVoxel: readonly [number, number, number];
  voxelSizeNm?: readonly [number, number, number];
  /** Global units per view unit; smaller = more zoomed in. */
  globalUnitsPerViewUnit?: number;
}): QuadCase {
  const frame = cursorFrame(
    options.voxelSizeNm ?? DEFAULT_TARGET_VOXEL_SIZE_NM,
  );
  const worldCenter = voxelToGlobal(frame, options.pointerVoxel);
  const projection = sliceProjection(
    options.orientation,
    worldCenter,
    options.globalUnitsPerViewUnit ?? GLOBAL_UNITS_PER_PIXEL,
  );
  const quad = computePaintedFootprintSliceQuad({
    radiusVoxels: options.paintedRadius,
    worldCenter: vec3.fromValues(
      worldCenter[0],
      worldCenter[1],
      worldCenter[2],
    ),
    frame,
    viewProjectionMat: projection.viewProjectionMat,
    invViewProjectionMat: projection.invViewProjectionMat,
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
    marginPixels: MARGIN_PIXELS,
  });
  expect(quad).toBeDefined();
  return { quad: quad as PaintedFootprintSliceQuad, frame, projection };
}

/**
 * Interpolated voxel offset at the screen position of an absolute target voxel's
 * center — i.e. what the fragment shader would see for that voxel. The voxel
 * need not lie on the slice plane: an orthographic projection maps it to the
 * screen position of the plane point directly in front of it, which is exactly
 * the fragment whose offset we want to check.
 */
function offsetAtAbsoluteVoxel(
  slice: QuadCase,
  absoluteVoxel: readonly [number, number, number],
): [number, number, number] {
  const [ndcX, ndcY] = projectToNdc(
    slice.projection,
    voxelToGlobal(slice.frame, [
      absoluteVoxel[0] + 0.5,
      absoluteVoxel[1] + 0.5,
      absoluteVoxel[2] + 0.5,
    ]),
  );
  return interpolateVoxelOffset(slice.quad, ndcX, ndcY);
}

/** Same, addressed relative to the stamp center voxel of `pointerVoxel`. */
function offsetAtVoxelCenter(
  slice: QuadCase,
  voxelOffsetFromCenter: readonly [number, number, number],
  pointerVoxel: readonly [number, number, number],
): [number, number, number] {
  return offsetAtAbsoluteVoxel(slice, [
    Math.floor(pointerVoxel[0]) + voxelOffsetFromCenter[0],
    Math.floor(pointerVoxel[1]) + voxelOffsetFromCenter[1],
    Math.floor(pointerVoxel[2]) + voxelOffsetFromCenter[2],
  ]);
}

describe("computePaintedFootprintSliceQuad", () => {
  it("maps each painted voxel's screen position to that voxel's offset (XY view)", () => {
    const pointerVoxel = [100.3, 200.8, 50.4] as const;
    const slice = buildQuad({
      orientation: ORIENTATIONS.xy,
      paintedRadius: 3,
      pointerVoxel,
    });
    for (const [offsetX, offsetY] of [
      [0, 0],
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
      [2, 2],
      [-2, -1],
    ]) {
      const offset = offsetAtVoxelCenter(
        slice,
        [offsetX, offsetY, 0],
        pointerVoxel,
      );
      expect(offset[0]).toBeCloseTo(offsetX + 0.5, 5);
      expect(offset[1]).toBeCloseTo(offsetY + 0.5, 5);
      // Z is the slice normal: constant across the quad, and inside the painted
      // voxel (`floor === 0`) so the footprint is not blanked out.
      expect(offset[2]).toBeCloseTo(pointerVoxel[2] - 50, 5);
      expect(Math.floor(offset[2])).toBe(0);
    }
  });

  it("keeps the painted slab one voxel thick in the XZ view", () => {
    const pointerVoxel = [100.3, 200.8, 50.4] as const;
    const slice = buildQuad({
      orientation: ORIENTATIONS.xz,
      paintedRadius: 4,
      pointerVoxel,
    });
    // Screen X → global X, screen Y → global Z. The disk is edge-on: it spans
    // the full diameter in X and exactly one voxel in Z.
    for (const offsetX of [-4, 0, 4]) {
      const offset = offsetAtVoxelCenter(slice, [offsetX, 0, 0], pointerVoxel);
      expect(offset[0]).toBeCloseTo(offsetX + 0.5, 5);
      expect(offset[2]).toBeCloseTo(0.5, 5);
      // Y is the slice normal here — constant, and inside the center voxel.
      expect(offset[1]).toBeCloseTo(pointerVoxel[1] - 200, 5);
      expect(Math.floor(offset[1])).toBe(0);
    }
    // One voxel step along Z lands outside the slab, in both directions.
    for (const offsetZ of [-1, 1]) {
      const offset = offsetAtVoxelCenter(slice, [0, 0, offsetZ], pointerVoxel);
      expect(Math.floor(offset[2])).toBe(offsetZ);
    }
  });

  it("keeps the painted slab one voxel thick in the YZ view", () => {
    const pointerVoxel = [100.3, 200.8, 50.4] as const;
    const slice = buildQuad({
      orientation: ORIENTATIONS.yz,
      paintedRadius: 4,
      pointerVoxel,
    });
    for (const offsetY of [-4, 0, 4]) {
      const offset = offsetAtVoxelCenter(slice, [0, offsetY, 0], pointerVoxel);
      expect(offset[1]).toBeCloseTo(offsetY + 0.5, 5);
      expect(offset[2]).toBeCloseTo(0.5, 5);
      expect(Math.floor(offset[0])).toBe(0);
    }
  });

  it("does not move while the pointer stays inside one voxel", () => {
    const first = buildQuad({
      orientation: ORIENTATIONS.xy,
      paintedRadius: 5,
      pointerVoxel: [100.01, 200.01, 50.5],
    });
    const second = buildQuad({
      orientation: ORIENTATIONS.xy,
      paintedRadius: 5,
      pointerVoxel: [100.99, 200.99, 50.5],
    });
    // The quad is placed from the stamp's center voxel, so sub-voxel pointer
    // motion cannot shift or reshape the footprint. (The projection follows the
    // pointer in this harness, so compare in global coordinates: the NDC bounds
    // move by exactly the pointer's own sub-voxel motion.)
    const firstWidth = first.quad.cornersNdc[2] - first.quad.cornersNdc[0];
    const secondWidth = second.quad.cornersNdc[2] - second.quad.cornersNdc[0];
    expect(secondWidth).toBeCloseTo(firstWidth, 6);
    // The fragment at a given painted voxel still reports that voxel's offset.
    for (const pointerVoxel of [
      [100.01, 200.01, 50.5],
      [100.99, 200.99, 50.5],
    ] as const) {
      const slice = pointerVoxel[0] === 100.01 ? first : second;
      const offset = offsetAtVoxelCenter(slice, [4, -3, 0], pointerVoxel);
      expect(offset[0]).toBeCloseTo(4.5, 5);
      expect(offset[1]).toBeCloseTo(-2.5, 5);
    }
  });

  it("steps a whole voxel when the pointer crosses a voxel boundary", () => {
    const inside = buildQuad({
      orientation: ORIENTATIONS.xy,
      paintedRadius: 2,
      pointerVoxel: [100.9, 200.5, 50.5],
    });
    const crossed = buildQuad({
      orientation: ORIENTATIONS.xy,
      paintedRadius: 2,
      pointerVoxel: [101.1, 200.5, 50.5],
    });
    // Absolute voxel 101 is one step right of the stamp center before the
    // crossing and the stamp center itself after it: the footprint translated by
    // exactly one voxel, not by the pointer's 0.2 voxel of travel.
    expect(offsetAtAbsoluteVoxel(inside, [101, 200, 50])[0]).toBeCloseTo(
      1.5,
      5,
    );
    expect(offsetAtAbsoluteVoxel(crossed, [101, 200, 50])[0]).toBeCloseTo(
      0.5,
      5,
    );
  });

  it("sizes the footprint by the target resolution, per axis", () => {
    const pointerVoxel = [100.5, 200.5, 50.5] as const;
    const paintedRadius = 4;
    // In-plane voxels 4× wider in Y than X → the footprint's screen bounding
    // box is 4× taller than it is wide, even though the disk is 2r+1 voxels
    // across in both.
    const slice = buildQuad({
      orientation: ORIENTATIONS.xy,
      paintedRadius,
      pointerVoxel,
      voxelSizeNm: [16, 64, 16],
    });
    const { cornersNdc } = slice.quad;
    const widthNdc = cornersNdc[2] - cornersNdc[0];
    const heightNdc = cornersNdc[5] - cornersNdc[1];
    // Undo the margin and the viewport aspect to recover the voxel extents.
    const marginNdcX = (2 * MARGIN_PIXELS) / VIEWPORT_WIDTH;
    const marginNdcY = (2 * MARGIN_PIXELS) / VIEWPORT_HEIGHT;
    const widthPixels = ((widthNdc - 2 * marginNdcX) * VIEWPORT_WIDTH) / 2;
    const heightPixels = ((heightNdc - 2 * marginNdcY) * VIEWPORT_HEIGHT) / 2;
    // The quad pads one voxel beyond the brush's reach on each side, so an even
    // size's half-voxel anchor cannot push the footprint outside it.
    const boxVoxels = 2 * (paintedRadius + 1) + 1;
    expect(widthPixels).toBeCloseTo(boxVoxels * pixelsPerVoxel(16), 4);
    expect(heightPixels).toBeCloseTo(boxVoxels * pixelsPerVoxel(64), 4);
  });

  it("covers a single voxel at radius 0", () => {
    const pointerVoxel = [100.5, 200.5, 50.5] as const;
    const slice = buildQuad({
      orientation: ORIENTATIONS.xy,
      paintedRadius: 0,
      pointerVoxel,
    });
    const offset = offsetAtVoxelCenter(slice, [0, 0, 0], pointerVoxel);
    expect(offset[0]).toBeCloseTo(0.5, 5);
    expect(offset[1]).toBeCloseTo(0.5, 5);
    const marginNdcX = (2 * MARGIN_PIXELS) / VIEWPORT_WIDTH;
    const widthPixels =
      ((slice.quad.cornersNdc[2] - slice.quad.cornersNdc[0] - 2 * marginNdcX) *
        VIEWPORT_WIDTH) /
      2;
    // One voxel for the footprint, plus the quad's one-voxel pad each side.
    expect(widthPixels).toBeCloseTo(3 * pixelsPerVoxel(16), 4);
  });

  it("returns undefined when the footprint is entirely off-screen", () => {
    const frame = cursorFrame(DEFAULT_TARGET_VOXEL_SIZE_NM);
    const worldCenter = voxelToGlobal(frame, [100.5, 200.5, 50.5]);
    // Center the viewport far away from the cursor.
    const projection = sliceProjection(
      ORIENTATIONS.xy,
      voxelToGlobal(frame, [100000.5, 200.5, 50.5]),
      GLOBAL_UNITS_PER_PIXEL,
    );
    const quad = computePaintedFootprintSliceQuad({
      radiusVoxels: 2,
      worldCenter: vec3.fromValues(
        worldCenter[0],
        worldCenter[1],
        worldCenter[2],
      ),
      frame,
      viewProjectionMat: projection.viewProjectionMat,
      invViewProjectionMat: projection.invViewProjectionMat,
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      marginPixels: MARGIN_PIXELS,
    });
    expect(quad).toBeUndefined();
  });

  it("returns undefined for a degenerate viewport", () => {
    const frame = cursorFrame(DEFAULT_TARGET_VOXEL_SIZE_NM);
    const projection = sliceProjection(
      ORIENTATIONS.xy,
      [0, 0, 0],
      GLOBAL_UNITS_PER_PIXEL,
    );
    expect(
      computePaintedFootprintSliceQuad({
        radiusVoxels: 2,
        worldCenter: vec3.create(),
        frame,
        viewProjectionMat: projection.viewProjectionMat,
        invViewProjectionMat: projection.invViewProjectionMat,
        viewportWidth: 0,
        viewportHeight: 0,
        marginPixels: MARGIN_PIXELS,
      }),
    ).toBeUndefined();
  });
});

describe("cursor voxel frame scales", () => {
  it("measures one target voxel in global units", () => {
    const frame = cursorFrame([64, 64, 64]);
    for (const nm of frame.globalVoxelSizeNm) {
      expect(nm).toBeCloseTo(GLOBAL_VOXEL_SIZE_NM, 9);
    }
    // A 64 nm target voxel spans 16 units of a 4 nm global space.
    expect(voxelToGlobal(frame, [1, 0, 0])[0]).toBeCloseTo(16, 9);
  });
});
