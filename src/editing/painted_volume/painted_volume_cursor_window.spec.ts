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

import type { CursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { PaintedVolumeCursorSnapshot } from "#src/editing/painted_volume/painted_volume_cursor_window.js";
import { paintedVolumeCursorFootprint } from "#src/editing/painted_volume/painted_volume_cursor_window.js";
import { vec3 } from "#src/util/geom.js";

const ISOTROPIC_FRAME: CursorVoxelFrame = {
  globalDimForSlot: [0, 1, 2],
  globalVoxelSizeNm: [4, 4, 40],
  targetVoxelSizeNm: [4, 4, 40],
};

const COARSER_TARGET_FRAME: CursorVoxelFrame = {
  globalDimForSlot: [0, 1, 2],
  globalVoxelSizeNm: [4, 4, 40],
  targetVoxelSizeNm: [8, 8, 40],
};

function cursorAt(
  worldCenter: vec3 | undefined,
  radiusVoxels = 2,
  visible = true,
): PaintedVolumeCursorSnapshot {
  return { visible, worldCenter, radiusVoxels };
}

const CENTER = vec3.fromValues(10.3, 20.7, 5.5);

describe("paintedVolumeCursorFootprint", () => {
  it("is undefined while the cursor is hidden or has no position", () => {
    expect(
      paintedVolumeCursorFootprint(cursorAt(CENTER, 2, false), ISOTROPIC_FRAME),
    ).toBeUndefined();
    expect(
      paintedVolumeCursorFootprint(cursorAt(undefined), ISOTROPIC_FRAME),
    ).toBeUndefined();
  });

  it("is undefined for an unusable radius or an unplaceable frame", () => {
    expect(
      paintedVolumeCursorFootprint(cursorAt(CENTER, -1), ISOTROPIC_FRAME),
    ).toBeUndefined();
    expect(
      paintedVolumeCursorFootprint(
        cursorAt(CENTER, Number.NaN),
        ISOTROPIC_FRAME,
      ),
    ).toBeUndefined();
    expect(paintedVolumeCursorFootprint(cursorAt(CENTER), undefined)).toBe(
      undefined,
    );
  });

  it("anchors an odd brush on the voxel under the pointer", () => {
    expect(
      paintedVolumeCursorFootprint(cursorAt(CENTER, 2), ISOTROPIC_FRAME),
    ).toEqual({ anchorVoxel: [10, 20, 5], radiusSquared: 4.25 });
  });

  it("anchors an even brush on the nearest voxel boundary", () => {
    expect(
      paintedVolumeCursorFootprint(cursorAt(CENTER, 1.5), ISOTROPIC_FRAME),
    ).toEqual({ anchorVoxel: [9.5, 20.5, 5], radiusSquared: 2.5 });
  });

  it("measures the pointer on the preview resolution's grid", () => {
    expect(
      paintedVolumeCursorFootprint(cursorAt(CENTER, 2), COARSER_TARGET_FRAME),
    ).toEqual({ anchorVoxel: [5, 10, 5], radiusSquared: 4.25 });
  });
});
