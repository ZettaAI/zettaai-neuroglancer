/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { layerId, Resolution } from "@zettaai/edit-session";
import { bench, describe } from "vitest";

import type { Vec3 } from "#src/editing/tool_runtimes/paint_rasterize.js";
import type { StrokeFootprintMask } from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";
import { computeEnclosedFootprint } from "#src/editing/tool_runtimes/stroke_enclosure.js";

const Z = 0;
const NO_LIMITS = {
  maxRasterVoxels: Number.MAX_SAFE_INTEGER,
  maxBoxVoxels: Number.MAX_SAFE_INTEGER,
  maxInteriorVoxels: Number.MAX_SAFE_INTEGER,
};

function ring(boxSize: number, segments: number): Vec3[] {
  const center = boxSize / 2;
  const reach = boxSize / 2 - 40;
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    points.push([
      center + reach * Math.cos(angle),
      center + reach * Math.sin(angle),
      Z,
    ]);
  }
  return points;
}

/** The expensive shape: long chords, as from a fast drag under `latestWins`. */
function scribble(boxSize: number, segments: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    points.push([
      ((i * 2654435761) >>> 0) % boxSize,
      ((i * 2246822519) >>> 0) % boxSize,
      Z,
    ]);
  }
  return points;
}

describe("computeEnclosedFootprint", () => {
  for (const boxSize of [512, 1024, 2048, 4096]) {
    const contour = ring(boxSize, 512);
    bench(`ring, box ${boxSize}, radius 16`, () => {
      computeEnclosedFootprint(contour, 16, undefined, NO_LIMITS);
    });
  }
  for (const segments of [16, 64]) {
    const contour = scribble(2048, segments);
    bench(`scribble, box 2048, ${segments} chords, radius 16`, () => {
      computeEnclosedFootprint(contour, 16, undefined, NO_LIMITS);
    });
  }
});

/**
 * The masked fill's main-thread route, with image chunks already resolved: the
 * cost of a fill under a mask that can reject voxels, before any network.
 */
describe("applyMaskedFootprint", () => {
  const resolution = Resolution.from([8, 8, 40]);
  const chunkSize = 64;
  const target = layerId("target");
  const image = layerId("image");
  const metadataFor = (
    id: typeof target,
    voxelDataType: "uint32" | "uint8",
  ) => ({
    layerId: id,
    voxelDataType,
    channels: 1,
    scales: [
      {
        resolution,
        voxelSizeNm: [8, 8, 40] as const,
        voxelOffset: [0, 0, 0] as const,
        sizeVoxels: [8192, 8192, 64] as const,
        chunkDataSize: [chunkSize, chunkSize, chunkSize] as const,
      },
    ],
  });
  const imageChunk = new Uint8Array(chunkSize ** 3).fill(200);
  const readChunkAt = async () => ({
    byteLength: imageChunk.length,
    asView: () => imageChunk,
  });
  const compute = new PaintingCompute();

  for (const [size, binaryClosing] of [
    [512, 0],
    [1024, 0],
    [1024, 1],
  ] as const) {
    const footprint: StrokeFootprintMask = {
      loTx: 0,
      loTy: 0,
      maskW: size,
      maskH: size,
      cz: 0,
      mask: new Uint8Array(size * size).fill(1),
    };
    bench(`footprint ${size}, closing ${binaryClosing}`, async () => {
      await compute.applyMaskedFootprint({
        targetLayerId: target,
        targetResolution: resolution,
        metadata: metadataFor(target, "uint32"),
        value: 7,
        footprint,
        maxImageVoxels: Number.MAX_SAFE_INTEGER,
        mask: {
          imageLayerId: image,
          imageResolution: resolution,
          thresholdLow: 100,
          thresholdHigh: 255,
          minComponentSize: 0,
          binaryClosing,
          filterComponentsFirst: false,
        },
        maskMetadata: metadataFor(image, "uint8"),
        maskAllowedResolutions: [resolution],
        readChunk: readChunkAt,
        readChunkAt,
      });
    });
  }
});
