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
 * @file The chunk size the edit session works with, per NG volume source
 * (TM-373, PR 9a).
 *
 * The edit library, the patch mirror and the patch textures all size their
 * per-chunk buffers from one `chunkDataSize`, and a baseline read pads every
 * NG chunk up to it (TM-353). With the nominal size, a volume smaller than one
 * chunk — the portal's 1238×1065 test data in 4096² chunks — pays for 4096²
 * on every copy, hash, decode and upload: ~12.7× the data it holds.
 *
 * On an axis where the whole volume fits in one chunk, every chunk has the
 * same extent along it — the volume's — so that extent is used instead.
 * Nothing about the grid changes: that axis still has exactly one chunk, at
 * coordinate 0, so chunk ids, grid positions and save boxes stay the same.
 * Every axis with more than one chunk keeps the nominal size.
 */

/** The `VolumeChunkSpecification` fields the extent depends on. */
export interface EditChunkSpec {
  /** Nominal chunk size; `[x, y, z, channels]` for volumes. */
  readonly chunkDataSize: ArrayLike<number>;
  /**
   * Data bounds in chunk-grid voxels: chunk 0 starts at 0. Absent bounds mean
   * an unknown extent, and the nominal size is kept.
   */
  readonly lowerVoxelBound?: ArrayLike<number>;
  readonly upperVoxelBound?: ArrayLike<number>;
}

/**
 * The `[x, y, z]` chunk size the edit session uses for `spec`: the volume's
 * extent on an axis it fills with one chunk, the nominal size otherwise.
 */
export function editChunkDataSize(
  spec: EditChunkSpec,
): [number, number, number] {
  return [
    editAxisExtent(spec, 0),
    editAxisExtent(spec, 1),
    editAxisExtent(spec, 2),
  ];
}

function editAxisExtent(spec: EditChunkSpec, axis: number): number {
  const nominal = spec.chunkDataSize[axis];
  const lower = spec.lowerVoxelBound?.[axis];
  const upper = spec.upperVoxelBound?.[axis];
  if (lower === undefined || upper === undefined) return nominal;
  // Chunk 0 covers [0, nominal). A volume starting elsewhere is left alone:
  // its library grid (anchored at the data's lower bound) would not line up
  // with NG's, so the clipped extent would not describe chunk 0.
  const fitsInOneChunk = lower === 0 && upper > 0 && upper <= nominal;
  return fitsInOneChunk ? upper : nominal;
}
