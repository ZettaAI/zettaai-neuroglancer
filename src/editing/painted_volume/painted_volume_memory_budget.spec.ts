/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, LayerMetadata } from "@zettaai/edit-session";
import { Resolution } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import {
  PAINTED_VOLUME_MAX_TEXTURE_BYTES,
  lockedRegionBytes,
  paintedVolumeBudgetBytes,
} from "#src/editing/painted_volume/painted_volume_memory_budget.js";

const RESOLUTION = Resolution.from([8, 8, 40]);
const MIB = 1024 * 1024;

function metadataOf(
  voxelOffset: readonly [number, number, number],
  channels = 1,
): LayerMetadata {
  return {
    layerId: "labels" as LayerId,
    voxelDataType: "uint32",
    channels,
    scales: [
      {
        resolution: RESOLUTION,
        voxelSizeNm: [8, 8, 40],
        voxelOffset,
        sizeVoxels: [1024, 1024, 128],
        chunkDataSize: [64, 64, 16],
      },
    ],
  };
}

const CHUNK_BYTES = 64 * 64 * 16 * 4;

describe("lockedRegionBytes", () => {
  it("counts whole chunks overlapping each region", () => {
    expect(
      lockedRegionBytes([
        {
          metadata: metadataOf([0, 0, 0]),
          resolution: RESOLUTION,
          bounds: { loX: 0, loY: 0, loZ: 0, hiX: 100, hiY: 64, hiZ: 16 },
        },
      ]),
    ).toBe(2 * CHUNK_BYTES);
  });

  it("places chunks on the scale's voxel offset", () => {
    expect(
      lockedRegionBytes([
        {
          metadata: metadataOf([10, 0, 0]),
          resolution: RESOLUTION,
          bounds: { loX: 10, loY: 0, loZ: 0, hiX: 74, hiY: 64, hiZ: 16 },
        },
      ]),
    ).toBe(CHUNK_BYTES);
  });

  it("sums layers and multiplies by channels", () => {
    const bounds = { loX: 0, loY: 0, loZ: 0, hiX: 64, hiY: 64, hiZ: 16 };
    expect(
      lockedRegionBytes([
        { metadata: metadataOf([0, 0, 0]), resolution: RESOLUTION, bounds },
        { metadata: metadataOf([0, 0, 0], 2), resolution: RESOLUTION, bounds },
      ]),
    ).toBe(3 * CHUNK_BYTES);
  });

  it("counts nothing for an empty region", () => {
    expect(
      lockedRegionBytes([
        {
          metadata: metadataOf([0, 0, 0]),
          resolution: RESOLUTION,
          bounds: { loX: 5, loY: 0, loZ: 0, hiX: 5, hiY: 64, hiZ: 16 },
        },
      ]),
    ).toBe(0);
  });
});

describe("paintedVolumeBudgetBytes", () => {
  it("is what the GPU limit leaves after the locked chunks", () => {
    expect(paintedVolumeBudgetBytes(1024 * MIB, 900 * MIB)).toBe(124 * MIB);
  });

  it("never exceeds the preview's own cap", () => {
    expect(paintedVolumeBudgetBytes(4096 * MIB, 0)).toBe(
      PAINTED_VOLUME_MAX_TEXTURE_BYTES,
    );
  });

  it("is zero when the locked chunks already fill the limit", () => {
    expect(paintedVolumeBudgetBytes(512 * MIB, 600 * MIB)).toBe(0);
  });
});
