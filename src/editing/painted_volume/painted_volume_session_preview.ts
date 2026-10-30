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
 * @file Builds a live preview from what the edit-session host has at hand.
 *
 * The host gathers its session state into `PaintedVolumeSessionInputs`; the GL
 * limits, the memory budget and the GPU half are derived here, so the host
 * adds no painted-volume logic of its own.
 */

import type { Logger } from "@zettaai/edit-session";

import { paintedVolumeGpuFactory } from "#src/editing/painted_volume/painted_volume_gpu.js";
import type { LockedLayerRegion } from "#src/editing/painted_volume/painted_volume_memory_budget.js";
import {
  lockedRegionBytes,
  paintedVolumeBudgetBytes,
} from "#src/editing/painted_volume/painted_volume_memory_budget.js";
import type { PaintedVolumePreviewOptions } from "#src/editing/painted_volume/painted_volume_preview.js";
import { PaintedVolumePreview } from "#src/editing/painted_volume/painted_volume_preview.js";
import type { GL } from "#src/webgl/context.js";

export interface PaintedVolumeSessionInputs
  extends Omit<
    PaintedVolumePreviewOptions,
    "createGpu" | "maxTextureDim" | "budgetBytes" | "logger"
  > {
  readonly gl: GL;
  readonly logger: Logger;
  /** The chunk manager's `gpuMemory.sizeLimit`. */
  readonly gpuMemoryLimitBytes: number;
  /** Every locked `(layer, resolution)` region of the session. */
  readonly lockedRegions: Iterable<LockedLayerRegion>;
}

export function createSessionPaintedVolumePreview(
  inputs: PaintedVolumeSessionInputs,
): PaintedVolumePreview {
  const { gl, logger, gpuMemoryLimitBytes, lockedRegions, ...options } = inputs;
  return new PaintedVolumePreview({
    ...options,
    logger,
    createGpu: paintedVolumeGpuFactory(gl, logger),
    maxTextureDim: gl.max3dTextureSize,
    budgetBytes: paintedVolumeBudgetBytes(
      gpuMemoryLimitBytes,
      lockedRegionBytes(lockedRegions),
    ),
  });
}
