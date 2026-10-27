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
 * The region fill stops taking chunks once a frame has spent its wall-clock
 * budget (plan §9.3), but always takes one, so the fill still finishes.
 */

import type {
  ChunkId,
  LayerId,
  LayerMetadata,
  SessionVoxelBounds,
} from "@zettaai/edit-session";
import { Resolution } from "@zettaai/edit-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalPatchStore } from "#src/editing/local_patch_store.js";
import type {
  PaintedVolumeFrameState,
  PaintedVolumeGpu,
} from "#src/editing/painted_volume/painted_volume_gpu.js";
import type { BaselineVoxelView } from "#src/editing/painted_volume/painted_volume_occupancy.js";
import { PaintedVolumePreview } from "#src/editing/painted_volume/painted_volume_preview.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import type { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { vec3 } from "#src/util/geom.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";
import { makeFakeSegmentationDisplayState } from "#tests/editing/fakes/fake_segmentation_display_state.js";
import type { FrameQueue } from "#tests/editing/harness/frame_queue.js";
import { installFrameQueue } from "#tests/editing/harness/frame_queue.js";

const RESOLUTION = Resolution.from([4, 4, 40]);
const CHUNK_VOLUME = 4 * 4 * 2;
/** Four chunks of 4 × 4 × 2. */
const REGION: SessionVoxelBounds = {
  loX: 0,
  loY: 0,
  loZ: 0,
  hiX: 8,
  hiY: 8,
  hiZ: 2,
};
const REGION_CHUNK_COUNT = 4;
/** What the fake clock advances on every `performance.now()`. */
const CLOCK_STEP_MS = 10;

const METADATA: LayerMetadata = {
  layerId: "labels" as LayerId,
  voxelDataType: "uint32",
  channels: 1,
  scales: [
    {
      resolution: RESOLUTION,
      voxelSizeNm: [4, 4, 40],
      voxelOffset: [0, 0, 0],
      sizeVoxels: [16, 16, 4],
      chunkDataSize: [4, 4, 2],
    },
  ],
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class NullGpu implements PaintedVolumeGpu {
  readonly renderLayer = {
    dispose: () => {},
  } as unknown as PerspectiveViewRenderLayer;
  constructor(readonly frame: PaintedVolumeFrameState) {}
  allocate(): boolean {
    return true;
  }
  uploadBox(): void {}
  uploadPalette(): void {}
  requestRedraw(): void {}
  dispose(): void {}
}

let frames: FrameQueue;
let previews: PaintedVolumePreview[] = [];

beforeEach(() => {
  frames = installFrameQueue();
  let clockMs = 0;
  vi.spyOn(performance, "now").mockImplementation(
    () => (clockMs += CLOCK_STEP_MS),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const preview of previews) preview.dispose();
  previews = [];
});

function makePreview(fillFrameBudgetMs: number): PaintedVolumePreview {
  const preview = new PaintedVolumePreview({
    createGpu: (frame) => new NullGpu(frame),
    resolution: RESOLUTION,
    regionBounds: REGION,
    metadata: METADATA,
    store: new LocalPatchStore(),
    displayState: makeFakeSegmentationDisplayState().displayState,
    displayInfo: new WatchableValue({
      displayRank: 3,
      displayDimensionIndices: Int32Array.of(0, 1, 2),
      displayDimensionScales: Float64Array.of(4e-9, 4e-9, 40e-9),
      displayDimensionUnits: ["m", "m", "m"],
    } as unknown as DisplayDimensionRenderInfo),
    readBaseline: (_chunkId: ChunkId): Promise<BaselineVoxelView> =>
      Promise.resolve(new Uint32Array(CHUNK_VOLUME)),
    cursor: {
      visible: new WatchableValue(false),
      worldCenter: new WatchableValue<vec3 | undefined>(undefined),
      radiusVoxels: new WatchableValue(0),
    },
    maxTextureDim: 2048,
    budgetBytes: 1 << 20,
    logger: new FakeLogger(),
    // Four chunks at once, so only the clock can hold the fill back.
    maxReadsInFlight: REGION_CHUNK_COUNT,
    fillFrameBudgetMs,
  });
  previews.push(preview);
  return preview;
}

function filledChunks(preview: PaintedVolumePreview): number {
  const status = preview.status.value;
  return status.kind === "live" ? status.fill.done : -1;
}

async function runFrame(): Promise<void> {
  await settle();
  frames.runFrame();
}

describe("PaintedVolumePreview fill frame budget", () => {
  it("stops taking landed chunks once the frame is over budget", async () => {
    // The first chunk is free; the clock reads +10 and +20 ms before the next
    // two (under the 25 ms budget) and +30 ms before the fourth, which waits.
    const preview = makePreview(25);
    await runFrame();
    expect(filledChunks(preview)).toBe(3);
    await runFrame();
    expect(filledChunks(preview)).toBe(REGION_CHUNK_COUNT);
  });

  it("takes one chunk per frame even with no budget left", async () => {
    const preview = makePreview(0);
    for (let frame = 1; frame <= REGION_CHUNK_COUNT; ++frame) {
      await runFrame();
      expect(filledChunks(preview)).toBe(frame);
    }
  });

  it("takes everything landed within a generous budget", async () => {
    const preview = makePreview(1000);
    await runFrame();
    expect(filledChunks(preview)).toBe(REGION_CHUNK_COUNT);
  });
});
