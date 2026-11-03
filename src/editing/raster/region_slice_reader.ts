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
 * @file Assemble a dense XY slice of a layer from its chunks, for the
 * z-extrapolation propagate protocol.
 *
 * The backend wants each slice as a flat, X-fastest buffer (`y * width + x`).
 * This gathers the covering chunks — the same offset-anchored chunk enumeration
 * the masked brush uses to read EM data ({@link imageChunksCovering}) — reads
 * each through the injected baseline reader, and copies the covered voxels into
 * a dense destination.
 *
 * This is the IMAGE (baseline) path: the image layer is read-only in a session,
 * so its committed/datasource bytes are the whole story. The MASK path must
 * instead read through the session overlay (baseline + live paint) via
 * `Edit.readRegion`, and lands in a later step once the write frame is pinned.
 */

import type {
  ChunkCoord,
  ChunkVoxelBuffer,
  LayerId,
  Resolution,
  ScaleMetadata,
} from "@zettaai/edit-session";
import { ChunkId } from "@zettaai/edit-session";

import type { VoxelTriple } from "#src/editing/tool_runtimes/mask_coord.js";
import { imageChunksCovering } from "#src/editing/tool_runtimes/mask_coord.js";
import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";

/**
 * A single-Z rectangular window in a layer's GLOBAL voxel frame at one
 * resolution — i.e. coordinates that INCLUDE the scale's `voxelOffset`, the same
 * frame {@link imageChunksCovering} consumes. `width`/`height` span X/Y; `z` is
 * the exact global voxel slice.
 */
export interface SliceWindow {
  readonly originX: number;
  readonly originY: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
}

/** The XY extent of a slice, without its Z — shared by every slice of a read. */
export type SliceArea = Omit<SliceWindow, "z">;

/**
 * Read a single-Z image slice as a dense, X-fastest `Float64Array`
 * (`y * width + x`, length `width * height`). Values are the layer's raw
 * scalars (widened from `bigint` where a chunk is `uint64`); normalization to
 * `uint8` is the caller's next step.
 *
 * The window must lie within the layer's data — session regions are validated
 * to overlap every session layer, so every covered chunk resolves. A chunk read
 * that rejects propagates.
 */
export async function readBaselineImageSlice(
  readChunkAt: ReadChunkAt,
  layerId: LayerId,
  resolution: Resolution,
  scale: ScaleMetadata,
  window: SliceWindow,
): Promise<Float64Array> {
  const [slice] = await readBaselineImageSlices(
    readChunkAt,
    layerId,
    resolution,
    scale,
    window,
    [window.z],
  );
  return slice;
}

/**
 * Read several single-Z slices of the same XY `area` at once, one dense
 * `Float64Array` per entry of `zs` (same order), each as
 * {@link readBaselineImageSlice} would return it.
 *
 * Every covering chunk is read exactly once, even when it holds more than one
 * of the requested slices (adjacent Z usually share a chunk), and all chunk
 * reads are in flight together rather than one after another (TM-518).
 */
export async function readBaselineImageSlices(
  readChunkAt: ReadChunkAt,
  layerId: LayerId,
  resolution: Resolution,
  scale: ScaleMetadata,
  area: SliceArea,
  zs: readonly number[],
): Promise<Float64Array[]> {
  const slices = zs.map(() => new Float64Array(area.width * area.height));
  const reads = [...chunksHoldingSlices(area, zs, scale)].map(
    async ({ coord, sliceIndices }) => {
      const buffer = await readChunkAt(
        layerId,
        resolution,
        ChunkId.fromCoord(coord),
      );
      const chunkOrigin: VoxelTriple = [
        coord.x * scale.chunkDataSize[0] + scale.voxelOffset[0],
        coord.y * scale.chunkDataSize[1] + scale.voxelOffset[1],
        coord.z * scale.chunkDataSize[2] + scale.voxelOffset[2],
      ];
      for (const sliceIndex of sliceIndices) {
        copyChunkSliceInto(
          buffer.asView(),
          scale.chunkDataSize,
          chunkOrigin,
          { ...area, z: zs[sliceIndex] },
          slices[sliceIndex],
        );
      }
    },
  );
  await Promise.all(reads);
  return slices;
}

/** A chunk covering the area, and which requested slices (indices into `zs`) it holds. */
interface ChunkHoldingSlices {
  readonly coord: ChunkCoord;
  readonly sliceIndices: number[];
}

/** The distinct chunks covering `area` at each Z in `zs`. */
function chunksHoldingSlices(
  area: SliceArea,
  zs: readonly number[],
  scale: ScaleMetadata,
): Iterable<ChunkHoldingSlices> {
  const byChunkKey = new Map<string, ChunkHoldingSlices>();
  zs.forEach((z, sliceIndex) => {
    const covering = imageChunksCovering(
      [area.originX, area.originY, z],
      [area.originX + area.width, area.originY + area.height, z + 1],
      scale,
    );
    for (const coord of covering) {
      const key = `${coord.x},${coord.y},${coord.z}`;
      const existing = byChunkKey.get(key);
      if (existing === undefined) {
        byChunkKey.set(key, { coord, sliceIndices: [sliceIndex] });
      } else {
        existing.sliceIndices.push(sliceIndex);
      }
    }
  });
  return byChunkKey.values();
}

/**
 * Copy the portion of `view` (one chunk, X-fastest, at `chunkOrigin`) that
 * falls inside `window`'s single Z into `out` at the window-relative position.
 * Voxels outside the chunk/window intersection are left untouched.
 */
function copyChunkSliceInto(
  view: ChunkVoxelBuffer,
  chunkSize: readonly [number, number, number],
  chunkOrigin: VoxelTriple,
  window: SliceWindow,
  out: Float64Array,
): void {
  const [chunkOriginX, chunkOriginY, chunkOriginZ] = chunkOrigin;
  const startX = Math.max(window.originX, chunkOriginX);
  const startY = Math.max(window.originY, chunkOriginY);
  const endX = Math.min(
    window.originX + window.width,
    chunkOriginX + chunkSize[0],
  );
  const endY = Math.min(
    window.originY + window.height,
    chunkOriginY + chunkSize[1],
  );

  const chunkStrideY = chunkSize[0];
  const chunkStrideZ = chunkSize[0] * chunkSize[1];
  const localZ = window.z - chunkOriginZ;
  const chunkZBase = localZ * chunkStrideZ;

  for (let globalY = startY; globalY < endY; globalY++) {
    const chunkRowBase = chunkZBase + (globalY - chunkOriginY) * chunkStrideY;
    const outRowBase = (globalY - window.originY) * window.width;
    for (let globalX = startX; globalX < endX; globalX++) {
      const value = view[chunkRowBase + (globalX - chunkOriginX)];
      out[outRowBase + (globalX - window.originX)] =
        typeof value === "bigint" ? Number(value) : value;
    }
  }
}
