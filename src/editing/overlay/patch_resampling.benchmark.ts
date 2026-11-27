/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Cost of showing edits on another pyramid level (TM-524): rebuilding the
 * one-slice box a brush stroke changed in a chunk of a level drawn at 2× the session's voxel size (zoomed out) or
 * at half of it (session coarser than the view). This runs on a frame that
 * draws a chunk a stroke just changed, so it is what painting zoomed out
 * costs on top of painting at the session's level.
 *
 *   npx vitest bench --run src/editing/overlay/patch_resampling.benchmark.ts
 */

import { bench, describe } from "vitest";

import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import type {
  LevelGeometry,
  ResampleSource,
} from "#src/editing/overlay/patch_resampling.js";
import { resamplePatchBox } from "#src/editing/overlay/patch_resampling.js";
import type { vec3 } from "#src/util/geom.js";

function level(scale: number, size: number): LevelGeometry {
  return {
    axes: [
      { scale, offset: 0 },
      { scale, offset: 0 },
      { scale: 1, offset: 0 },
    ],
    chunkDataSize: [size, size, 16],
    lowerVoxelBound: [0, 0, 0],
    upperVoxelBound: [Infinity, Infinity, Infinity],
  };
}

/** A stored 256²×16 chunk with a painted disc of `radius` voxels on every slice. */
function paintedChunk(radius: number): LocalPatchChunk {
  const chunk = new LocalPatchChunk([256, 256, 16] as unknown as vec3);
  for (let z = 0; z < 16; ++z) {
    for (let y = 0; y < 256; ++y) {
      for (let x = 0; x < 256; ++x) {
        if ((x - 128) ** 2 + (y - 128) ** 2 > radius ** 2) continue;
        const index = x + 256 * (y + 256 * z);
        chunk.data[index] = 7n;
        chunk.patched[index] = 1;
      }
    }
  }
  return chunk;
}

function sourceOf(
  geometry: LevelGeometry,
  chunk: LocalPatchChunk,
): ResampleSource {
  return {
    geometry,
    chunkAt: (x, y, z) => (x === 0 && y === 0 && z === 0 ? chunk : undefined),
  };
}

for (const radius of [8, 32, 96]) {
  describe(`brush radius ${radius} (one 256²×16 chunk)`, () => {
    const stored = paintedChunk(radius);
    const fine = level(1, 256);
    const coarse = level(2, 256);
    // The stroke's box in each target level.
    const coarseBox = {
      x0: Math.floor((128 - radius) / 2),
      y0: Math.floor((128 - radius) / 2),
      z0: 0,
      x1: Math.ceil((128 + radius) / 2),
      y1: Math.ceil((128 + radius) / 2),
      z1: 0,
    };
    const fineBox = {
      x0: 128 - radius,
      y0: 128 - radius,
      z0: 0,
      x1: 128 + radius,
      y1: 128 + radius,
      z1: 0,
    };
    const coarseTarget = new LocalPatchChunk([256, 256, 16] as unknown as vec3);
    const fineTarget = new LocalPatchChunk([256, 256, 16] as unknown as vec3);

    bench("zoomed out: session 16 nm, level 32 nm drawn", () => {
      resamplePatchBox(
        [sourceOf(fine, stored)],
        coarse,
        [0, 0, 0],
        coarseTarget,
        coarseBox,
      );
    });

    bench("session 32 nm, level 16 nm drawn", () => {
      resamplePatchBox(
        [sourceOf(coarse, stored)],
        fine,
        [0, 0, 0],
        fineTarget,
        fineBox,
      );
    });
  });
}
