/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file The window the preview keeps clear under the 3D brush cursor.
 *
 * The cursor ellipsoid sits in the stroke plane, where the preview's cubes
 * would hide it; instead of moving the cursor, the preview leaves out the
 * cells the brush would paint on the cursor's z (plan §3.11). The footprint is
 * the brush's own: `brushStampAnchor` + `brushRadiusSquared`, measured on the
 * preview resolution's voxel grid exactly as `snapWorldCenterToStampCenter`
 * does for the cursor itself.
 */

import type { CursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { PaintedVolumeCursorFootprint } from "#src/editing/painted_volume/painted_volume_render_layer.js";
import { globalToTargetVoxel } from "#src/editing/raster/global_voxel_conversion.js";
import {
  brushRadiusSquared,
  brushStampAnchor,
} from "#src/editing/tool_runtimes/brush_disk_footprint.js";
import type { vec3 } from "#src/util/geom.js";

/** The `BrushCursorState` values the window depends on. */
export interface PaintedVolumeCursorSnapshot {
  readonly visible: boolean;
  /** Pointer position in global coordinates. */
  readonly worldCenter: vec3 | undefined;
  readonly radiusVoxels: number;
}

/**
 * Footprint to keep clear, or `undefined` while the cursor is hidden, has no
 * position, or cannot be placed in the view (`frame` from
 * `resolveCursorVoxelFrame` for the preview resolution).
 */
export function paintedVolumeCursorFootprint(
  cursor: PaintedVolumeCursorSnapshot,
  frame: CursorVoxelFrame | undefined,
): PaintedVolumeCursorFootprint | undefined {
  const { visible, worldCenter, radiusVoxels } = cursor;
  if (!visible || worldCenter === undefined || frame === undefined) {
    return undefined;
  }
  // A brush size of 1 is radius 0 — a single voxel, not an empty footprint.
  if (!Number.isFinite(radiusVoxels) || radiusVoxels < 0) return undefined;
  const pointerVoxel = globalToTargetVoxel(
    [worldCenter[0], worldCenter[1], worldCenter[2]],
    frame.globalVoxelSizeNm,
    frame.targetVoxelSizeNm,
  );
  return {
    anchorVoxel: brushStampAnchor(pointerVoxel, radiusVoxels),
    radiusSquared: brushRadiusSquared(radiusVoxels),
  };
}
