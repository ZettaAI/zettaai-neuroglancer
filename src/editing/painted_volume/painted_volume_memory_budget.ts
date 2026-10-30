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
 * @file GPU memory the painted-volume texture may take (plan §3.4).
 *
 * The texture lives outside the chunk manager: it neither counts against
 * `gpuMemoryLimit` nor can be evicted. So it takes at most what the limit
 * leaves after the session's locked chunks, and never more than its own cap.
 *
 * The locked chunks are counted from the session's frozen region — every chunk
 * overlapping it, at every opened resolution — rather than through the entry
 * modal's `estimateLockedMemory`, whose inputs (modal rows, the picked bbox)
 * no longer exist once the session is open.
 */

import type {
  LayerMetadata,
  Resolution,
  SessionVoxelBounds,
} from "@zettaai/edit-session";
import { ChunkGrid, bytesPerVoxel, scaleFor } from "@zettaai/edit-session";

export const PAINTED_VOLUME_MAX_TEXTURE_BYTES = 256 * 1024 * 1024;

/** One locked `(layer, resolution)` region of the session. */
export interface LockedLayerRegion {
  readonly metadata: LayerMetadata;
  readonly resolution: Resolution;
  /** Exclusive `hi`, as `SessionRegionSnapshot.boundsFor` returns it. */
  readonly bounds: SessionVoxelBounds;
}

/** Bytes of every whole chunk the regions pin, across all channels. */
export function lockedRegionBytes(
  regions: Iterable<LockedLayerRegion>,
): number {
  let total = 0;
  for (const { metadata, resolution, bounds } of regions) {
    const size: [number, number, number] = [
      bounds.hiX - bounds.loX,
      bounds.hiY - bounds.loY,
      bounds.hiZ - bounds.loZ,
    ];
    if (size.some((extent) => extent <= 0)) continue;
    const chunkCount = ChunkGrid.fromLayer(
      metadata,
      resolution,
    ).chunkIdsOverlappingBox([bounds.loX, bounds.loY, bounds.loZ], size).length;
    const [chunkSizeX, chunkSizeY, chunkSizeZ] = scaleFor(
      metadata,
      resolution,
    ).chunkDataSize;
    const chunkBytes =
      chunkSizeX *
      chunkSizeY *
      chunkSizeZ *
      bytesPerVoxel(metadata.voxelDataType) *
      Math.max(1, metadata.channels);
    total += chunkCount * chunkBytes;
  }
  return total;
}

/** Texture budget: the GPU limit's remainder after `lockedBytes`, capped. */
export function paintedVolumeBudgetBytes(
  gpuLimitBytes: number,
  lockedBytes: number,
): number {
  return Math.max(
    0,
    Math.min(PAINTED_VOLUME_MAX_TEXTURE_BYTES, gpuLimitBytes - lockedBytes),
  );
}
