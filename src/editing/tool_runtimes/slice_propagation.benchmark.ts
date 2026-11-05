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
 * Cost of one z-extrapolation step on the client (TM-518), with the backend
 * replaced by an instant fake so only our own work is timed: reading the image
 * slices, labelizing the mask, decoding the prediction.
 *
 * The region is 2048×2048 voxels (a large session region), the image is uint8
 * in 128×128×16 chunks, the mask is uint64 with a handful of large segments.
 * "Cold" reads add a fixed latency per chunk read, standing in for a chunk that
 * is not yet in system memory.
 */

import type {
  ChunkId,
  Edit,
  LayerId,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  ScaleMetadata,
  VoxelBox,
} from "@zettaai/edit-session";
import { layerId, Resolution as ResolutionCtor } from "@zettaai/edit-session";
import { bench, describe } from "vitest";

import { readBaselineImageSlices } from "#src/editing/raster/region_slice_reader.js";
import { imageScalarToUint8 } from "#src/editing/tool_runtimes/image_scalar_to_uint8.js";
import {
  buildLabelMap,
  delabelizeMaskSlice,
  labelizeMaskSlice,
} from "#src/editing/tool_runtimes/mask_label_codec.js";
import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";
import type { MultipartPoster } from "#src/editing/tool_runtimes/propagate_mask_client.js";
import { propagateSlice } from "#src/editing/tool_runtimes/slice_propagation.js";

const REGION_SIZE = 2048;
const REGION_VOXELS = REGION_SIZE * REGION_SIZE;
const CHUNK_SIZE = [128, 128, 16] as const;
const COLD_CHUNK_LATENCY_MS = 2;
const SEGMENT_STRIPE_WIDTH = 256;
const TRACKED_IDS = [
  0x1_0000_0001n,
  0x1_0000_0002n,
  0x1_0000_0003n,
  0x1_0000_0004n,
];

const IMAGE: LayerId = layerId("image");
const MASK: LayerId = layerId("mask");
const RESOLUTION: Resolution = ResolutionCtor.from([8, 8, 40]);
const SCALE: ScaleMetadata = {
  resolution: RESOLUTION,
  voxelSizeNm: [8, 8, 40],
  voxelOffset: [0, 0, 0],
  sizeVoxels: [REGION_SIZE, REGION_SIZE, 64],
  chunkDataSize: [...CHUNK_SIZE],
};

/** Vertical stripes of segments: realistic runs of equal ids. Some are untracked. */
function stripedMask(): BigUint64Array {
  const mask = new BigUint64Array(REGION_VOXELS);
  const stripeIds = [...TRACKED_IDS, 0n, 0x2_0000_0009n, 77n];
  for (let voxel = 0; voxel < REGION_VOXELS; voxel++) {
    const x = voxel % REGION_SIZE;
    mask[voxel] =
      stripeIds[Math.floor(x / SEGMENT_STRIPE_WIDTH) % stripeIds.length];
  }
  return mask;
}

function imageChunk(): Uint8Array {
  const [sizeX, sizeY, sizeZ] = CHUNK_SIZE;
  const chunk = new Uint8Array(sizeX * sizeY * sizeZ);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i & 0xff;
  return chunk;
}

function chunkReader(latencyMs: number): ReadChunkAt {
  const view = imageChunk();
  const buffer: ReadonlyChunkVoxelBuffer = {
    byteLength: view.byteLength,
    asView: () => view,
  };
  return (_layer: LayerId, _resolution: Resolution, _chunkId: ChunkId) =>
    latencyMs === 0
      ? Promise.resolve(buffer)
      : new Promise((resolve) => setTimeout(() => resolve(buffer), latencyMs));
}

function fakeEdit(mask: BigUint64Array): Edit {
  return {
    readRegion: (_target: unknown, box: VoxelBox) =>
      Promise.resolve({ box, data: mask }),
    writeRegion: () => Promise.resolve(),
  } as unknown as Edit;
}

/** Instant backend that predicts "every voxel is label 1". */
function instantBackend(): MultipartPoster {
  const header = new TextEncoder().encode(
    JSON.stringify({ mask_shape: [REGION_SIZE, REGION_SIZE] }),
  );
  const body = new Uint8Array(4 + header.length + REGION_VOXELS);
  new DataView(body.buffer).setUint32(0, header.length, true);
  body.set(header, 4);
  body.fill(1, 4 + header.length);
  return {
    postMultipart: () => Promise.resolve(new Response(body.slice())),
  };
}

function runStep(readChunkAt: ReadChunkAt, mask: BigUint64Array) {
  const window = {
    originX: 0,
    originY: 0,
    width: REGION_SIZE,
    height: REGION_SIZE,
    currentZ: 7,
    nextZ: 8,
  };
  return propagateSlice({
    edit: fakeEdit(mask),
    readChunkAt,
    client: instantBackend(),
    image: {
      layerId: IMAGE,
      resolution: RESOLUTION,
      scale: SCALE,
      dataType: "uint8",
    },
    mask: {
      layerId: MASK,
      resolution: RESOLUTION,
      scale: SCALE,
      dataType: "uint64",
    },
    imageWindow: window,
    maskWindow: window,
    trackedIds: TRACKED_IDS,
  });
}

const mask = stripedMask();
const { idToLabel, labelToId } = buildLabelMap(TRACKED_IDS);
const labels = labelizeMaskSlice(mask, idToLabel);
const warmReader = chunkReader(0);

describe("z-extrapolation kernels (2048×2048)", () => {
  bench("labelize uint64 mask", () => {
    labelizeMaskSlice(mask, idToLabel);
  });

  bench("delabelize prediction", () => {
    delabelizeMaskSlice(labels, labelToId);
  });

  bench("read + normalize current and next image slices (warm)", async () => {
    const slices = await readBaselineImageSlices(
      warmReader,
      IMAGE,
      RESOLUTION,
      SCALE,
      { originX: 0, originY: 0, width: REGION_SIZE, height: REGION_SIZE },
      [7, 8],
    );
    for (const slice of slices) imageScalarToUint8(slice, "uint8");
  });
});

describe("z-extrapolation step, instant backend (2048×2048)", () => {
  bench(
    "warm chunks",
    async () => {
      await runStep(chunkReader(0), mask);
    },
    { iterations: 5, warmupIterations: 1 },
  );

  bench(
    `cold chunks (${COLD_CHUNK_LATENCY_MS} ms per chunk read)`,
    async () => {
      await runStep(chunkReader(COLD_CHUNK_LATENCY_MS), mask);
    },
    { iterations: 5, warmupIterations: 1 },
  );
});
