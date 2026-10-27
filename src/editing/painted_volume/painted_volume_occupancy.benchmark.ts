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
 * Cost of the occupancy kernel on a realistic chunk (128×128×64, uint32
 * baseline, a few large segments). Targets: a stroke-sized delta box under
 * 2 ms; the full-chunk refill sets the per-frame voxel budget of the preview.
 */

import { bench, describe } from "vitest";

import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import type { PaintedVolumeChunkVoxels } from "#src/editing/painted_volume/painted_volume_occupancy.js";
import { writeOccupancyForBox } from "#src/editing/painted_volume/painted_volume_occupancy.js";
import { PaintedVolumeSegmentPalette } from "#src/editing/painted_volume/painted_volume_segment_palette.js";
import type { PaintedVolumeShownSegments } from "#src/editing/painted_volume/painted_volume_shown_segments.js";
import { vec3 } from "#src/util/geom.js";

const CHUNK_SIZE = [128, 128, 64] as const;
const [CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z] = CHUNK_SIZE;
const CHUNK_VOLUME = CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z;
const SEGMENT_STRIPE_WIDTH = 32;
const PAINTED_ID = 3n;

const shownIds = new Set([1n, 3n]);
const shown: PaintedVolumeShownSegments = { has: (id) => shownIds.has(id) };

/** Vertical stripes of segments 1..4, so runs of equal ids are realistic. */
function stripedBaseline(): Uint32Array {
  const baseline = new Uint32Array(CHUNK_VOLUME);
  for (let voxel = 0; voxel < CHUNK_VOLUME; ++voxel) {
    const x = voxel % CHUNK_SIZE_X;
    baseline[voxel] = 1 + Math.floor(x / SEGMENT_STRIPE_WIDTH);
  }
  return baseline;
}

/** A 32×32 stroke on one z slice, painted with a shown segment. */
function strokePatch(): LocalPatchChunk {
  const patch = new LocalPatchChunk(vec3.fromValues(...CHUNK_SIZE));
  const z = CHUNK_SIZE_Z / 2;
  for (let y = 48; y < 80; ++y) {
    for (let x = 48; x < 80; ++x) {
      const voxel = (z * CHUNK_SIZE_Y + y) * CHUNK_SIZE_X + x;
      patch.data[voxel] = PAINTED_ID;
      patch.patched[voxel] = 1;
    }
  }
  return patch;
}

function extentWithFactor(factor: number): PaintedVolumeExtent {
  return {
    textureOrigin: [0, 0, 0],
    factor: [factor, factor, 1],
    textureSize: [CHUNK_SIZE_X / factor, CHUNK_SIZE_Y / factor, CHUNK_SIZE_Z],
  };
}

const baseline = stripedBaseline();
const paintedChunk: PaintedVolumeChunkVoxels = {
  origin: [0, 0, 0],
  size: CHUNK_SIZE,
  baseline,
  patch: strokePatch(),
};
const unpaintedChunk: PaintedVolumeChunkVoxels = {
  ...paintedChunk,
  patch: undefined,
};
const strokeBox = { x0: 48, y0: 48, z0: 32, x1: 79, y1: 79, z1: 32 };
const wholeChunk = {
  x0: 0,
  y0: 0,
  z0: 0,
  x1: CHUNK_SIZE_X - 1,
  y1: CHUNK_SIZE_Y - 1,
  z1: CHUNK_SIZE_Z - 1,
};
const palette = new PaintedVolumeSegmentPalette();
const scratch = new Uint8Array(CHUNK_VOLUME);

describe("painted_volume_occupancy", () => {
  for (const factor of [1, 2]) {
    const extent = extentWithFactor(factor);
    bench(`stroke delta 32×32×1, factor ${factor}`, () => {
      writeOccupancyForBox(
        paintedChunk,
        strokeBox,
        extent,
        shown,
        palette,
        scratch,
      );
    });
  }

  bench("full chunk 128×128×64 refill, no patch", () => {
    writeOccupancyForBox(
      unpaintedChunk,
      wholeChunk,
      extentWithFactor(1),
      shown,
      palette,
      scratch,
    );
  });
});
