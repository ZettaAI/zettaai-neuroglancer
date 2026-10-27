/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  ChunkId,
  LayerId,
  LayerMetadata,
  SessionVoxelBounds,
} from "@zettaai/edit-session";
import { ChunkId as ChunkIdFactory, Resolution } from "@zettaai/edit-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { PAINTED_VOLUME_BYTES_PER_TEXEL } from "#src/editing/painted_volume/painted_volume_extent.js";
import type {
  PaintedVolumeFrameState,
  PaintedVolumeGpu,
} from "#src/editing/painted_volume/painted_volume_gpu.js";
import type { BaselineVoxelView } from "#src/editing/painted_volume/painted_volume_occupancy.js";
import type { PaintedVolumePreviewOptions } from "#src/editing/painted_volume/painted_volume_preview.js";
import { PaintedVolumePreview } from "#src/editing/painted_volume/painted_volume_preview.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import type { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { vec3 } from "#src/util/geom.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";
import type { FakeSegmentationDisplayState } from "#tests/editing/fakes/fake_segmentation_display_state.js";
import { makeFakeSegmentationDisplayState } from "#tests/editing/fakes/fake_segmentation_display_state.js";
import type { FrameQueue } from "#tests/editing/harness/frame_queue.js";
import { installFrameQueue } from "#tests/editing/harness/frame_queue.js";

type Triple = readonly [number, number, number];

const RESOLUTION = Resolution.from([4, 4, 40]);
const CHUNK_SIZE: Triple = [4, 4, 2];
const CHUNK_VOLUME = 32;
/** Four chunks: (0,0,0) (1,0,0) (0,1,0) (1,1,0); the texture is 8 × 8 × 2. */
const REGION: SessionVoxelBounds = {
  loX: 0,
  loY: 0,
  loZ: 0,
  hiX: 8,
  hiY: 8,
  hiZ: 2,
};
const TEXTURE_SIZE: Triple = [8, 8, 2];
const REGION_CHUNK_COUNT = 4;

const SELECTED = 5n;
const OTHER = 9n;
/** A selected segment the tests paint with. */
const PAINTED = 7n;

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
      chunkDataSize: [...CHUNK_SIZE],
    },
  ],
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function chunkPositionOf(voxel: Triple): Triple {
  return [
    Math.floor(voxel[0] / CHUNK_SIZE[0]),
    Math.floor(voxel[1] / CHUNK_SIZE[1]),
    Math.floor(voxel[2] / CHUNK_SIZE[2]),
  ];
}

function localIndexOf(voxel: Triple): number {
  const localX = voxel[0] % CHUNK_SIZE[0];
  const localY = voxel[1] % CHUNK_SIZE[1];
  const localZ = voxel[2] % CHUNK_SIZE[2];
  return (localZ * CHUNK_SIZE[1] + localY) * CHUNK_SIZE[0] + localX;
}

function singleVoxelBox(voxel: Triple) {
  const localX = voxel[0] % CHUNK_SIZE[0];
  const localY = voxel[1] % CHUNK_SIZE[1];
  const localZ = voxel[2] % CHUNK_SIZE[2];
  return {
    x0: localX,
    y0: localY,
    z0: localZ,
    x1: localX,
    y1: localY,
    z1: localZ,
  };
}

/** A texture that is a byte array, recording what the controller sends. */
class FakeGpu implements PaintedVolumeGpu {
  readonly renderLayer = {
    dispose: () => {},
  } as unknown as PerspectiveViewRenderLayer;
  bytes = new Uint8Array(0);
  size: Triple | undefined;
  palette = new Uint8Array(0);
  uploads: TexelBox[] = [];
  paletteUploads = 0;
  redraws = 0;
  disposed = false;
  refuseAllocation = false;

  constructor(readonly frame: PaintedVolumeFrameState) {}

  allocate(size: Triple): boolean {
    if (this.refuseAllocation) return false;
    this.size = size;
    this.bytes = new Uint8Array(size[0] * size[1] * size[2]);
    return true;
  }

  uploadBox(texelBox: TexelBox, bytes: Uint8Array): void {
    this.uploads.push({ ...texelBox });
    const [sizeX, sizeY] = this.size!;
    let source = 0;
    for (let z = texelBox.z0; z <= texelBox.z1; ++z) {
      for (let y = texelBox.y0; y <= texelBox.y1; ++y) {
        for (let x = texelBox.x0; x <= texelBox.x1; ++x) {
          this.bytes[(z * sizeY + y) * sizeX + x] = bytes[source++];
        }
      }
    }
  }

  uploadPalette(colors: Uint8Array): void {
    this.palette = colors.slice();
    ++this.paletteUploads;
  }

  requestRedraw(): void {
    ++this.redraws;
  }

  dispose(): void {
    this.disposed = true;
  }

  classAt(voxel: Triple): number {
    const [sizeX, sizeY] = this.size!;
    return this.bytes[(voxel[2] * sizeY + voxel[1]) * sizeX + voxel[0]];
  }

  alphaOfClass(segmentClass: number): number {
    return this.palette[segmentClass * 4 + 3];
  }

  rgbOfClass(segmentClass: number): number[] {
    return Array.from(
      this.palette.subarray(segmentClass * 4, segmentClass * 4 + 3),
    );
  }
}

interface ManualRead {
  readonly key: string;
  readonly signal: AbortSignal;
  resolve(): void;
}

class FakeDatasource {
  readonly baselineByKey = new Map<string, Uint32Array>();
  readonly deferredKeys = new Set<string>();
  readonly failingKeys = new Set<string>();
  readonly manualReads: ManualRead[] = [];
  readonly readCountByKey = new Map<string, number>();

  setVoxel(voxel: Triple, id: bigint): void {
    const key = chunkPositionOf(voxel).join(",");
    let baseline = this.baselineByKey.get(key);
    if (baseline === undefined) {
      baseline = new Uint32Array(CHUNK_VOLUME);
      this.baselineByKey.set(key, baseline);
    }
    baseline[localIndexOf(voxel)] = Number(id);
  }

  read = (
    chunkId: ChunkId,
    signal: AbortSignal,
  ): Promise<BaselineVoxelView> => {
    const { x, y, z } = ChunkIdFactory.toCoord(chunkId);
    const key = `${x},${y},${z}`;
    this.readCountByKey.set(key, (this.readCountByKey.get(key) ?? 0) + 1);
    const snapshot = () =>
      (this.baselineByKey.get(key) ?? new Uint32Array(CHUNK_VOLUME)).slice();
    if (this.failingKeys.has(key)) {
      return Promise.reject(new Error(`chunk ${key} unreadable`));
    }
    if (this.deferredKeys.has(key)) {
      return new Promise((resolve) => {
        this.manualReads.push({
          key,
          signal,
          resolve: () => resolve(snapshot()),
        });
      });
    }
    return Promise.resolve(snapshot());
  };
}

function makeDisplayInfo(scaleZ = 40e-9): DisplayDimensionRenderInfo {
  return {
    displayRank: 3,
    displayDimensionIndices: Int32Array.of(0, 1, 2),
    displayDimensionScales: Float64Array.of(4e-9, 4e-9, scaleZ),
    displayDimensionUnits: ["m", "m", "m"],
  } as unknown as DisplayDimensionRenderInfo;
}

interface Harness {
  readonly preview: PaintedVolumePreview;
  readonly gpu: FakeGpu;
  readonly store: LocalPatchStore;
  readonly datasource: FakeDatasource;
  readonly segments: FakeSegmentationDisplayState;
  readonly cursor: {
    visible: WatchableValue<boolean>;
    worldCenter: WatchableValue<vec3 | undefined>;
    radiusVoxels: WatchableValue<number>;
  };
  readonly displayInfo: WatchableValue<DisplayDimensionRenderInfo>;
  readonly logger: FakeLogger;
  /** Paint `voxel` with `value` in the store, as `PatchMirror` does. */
  paint(voxel: Triple, value: bigint): void;
  /** Settle reads and run frames until the controller has nothing left. */
  idle(): Promise<void>;
}

let frames: FrameQueue;
let harnesses: Harness[] = [];

beforeEach(() => {
  frames = installFrameQueue();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const harness of harnesses) {
    harness.preview.dispose();
    harness.store.dispose();
  }
  harnesses = [];
});

interface HarnessSetup {
  datasource?: FakeDatasource;
  store?: LocalPatchStore;
  options?: Partial<PaintedVolumePreviewOptions>;
  refuseAllocation?: boolean;
}

function makeHarness(setup: HarnessSetup = {}): Harness {
  const datasource = setup.datasource ?? new FakeDatasource();
  const store = setup.store ?? new LocalPatchStore();
  const segments = makeFakeSegmentationDisplayState();
  segments.visibleSegments.add([SELECTED, PAINTED]);
  const cursor = {
    visible: new WatchableValue(false),
    worldCenter: new WatchableValue<vec3 | undefined>(undefined),
    radiusVoxels: new WatchableValue(0),
  };
  const displayInfo = new WatchableValue(makeDisplayInfo());
  const logger = new FakeLogger();
  let gpu: FakeGpu | undefined;
  const preview = new PaintedVolumePreview({
    createGpu: (frame) => {
      gpu = new FakeGpu(frame);
      gpu.refuseAllocation = setup.refuseAllocation ?? false;
      return gpu;
    },
    resolution: RESOLUTION,
    regionBounds: REGION,
    metadata: METADATA,
    store,
    displayState: segments.displayState,
    displayInfo,
    readBaseline: datasource.read,
    cursor,
    maxTextureDim: 2048,
    budgetBytes: 1 << 20,
    logger,
    ...setup.options,
  });
  const harness: Harness = {
    preview,
    gpu: gpu!,
    store,
    datasource,
    segments,
    cursor,
    displayInfo,
    logger,
    paint: (voxel, value) => {
      const position = chunkPositionOf(voxel);
      const chunk = store.source.getOrCreateChunk(position, CHUNK_SIZE);
      chunk.data[localIndexOf(voxel)] = value;
      chunk.patched[localIndexOf(voxel)] = 1;
      store.noteChunkMutated(position, singleVoxelBox(voxel));
    },
    idle: async () => {
      for (let round = 0; round < 50; ++round) {
        await settle();
        if (frames.pendingCount === 0) return;
        frames.runFrame();
      }
      throw new Error("preview never went idle");
    },
  };
  harnesses.push(harness);
  return harness;
}

describe("PaintedVolumePreview: region fill", () => {
  it("shows every voxel of a selected segment and nothing of the others", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    datasource.setVoxel([6, 5, 1], SELECTED);
    datasource.setVoxel([2, 6, 0], OTHER);
    const { gpu, idle } = makeHarness({ datasource });
    await idle();

    expect(gpu.size).toEqual(TEXTURE_SIZE);
    expect(gpu.classAt([1, 1, 0])).not.toBe(0);
    expect(gpu.classAt([6, 5, 1])).toBe(gpu.classAt([1, 1, 0]));
    expect(gpu.classAt([2, 6, 0])).toBe(0);
    expect(gpu.alphaOfClass(gpu.classAt([1, 1, 0]))).toBe(255);
  });

  it("spreads over frames within the voxel budget, without further events", async () => {
    const { preview, gpu } = makeHarness({
      options: { voxelBudgetPerFrame: CHUNK_VOLUME },
    });
    const fillProgress = () => {
      const status = preview.status.value;
      return status.kind === "live" ? status.fill.done : -1;
    };
    await settle();
    frames.runFrame();
    expect(fillProgress()).toBe(1);
    await settle();
    frames.runFrame();
    expect(fillProgress()).toBe(2);
    for (let round = 0; round < 10 && frames.pendingCount > 0; ++round) {
      await settle();
      frames.runFrame();
    }
    expect(fillProgress()).toBe(REGION_CHUNK_COUNT);
    expect(gpu.uploads).toHaveLength(REGION_CHUNK_COUNT);
  });

  it("draws a chunk whose baseline arrives late, when it arrives", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([5, 1, 0], SELECTED);
    datasource.deferredKeys.add("1,0,0");
    const { gpu, idle } = makeHarness({ datasource });
    await idle();
    expect(gpu.classAt([5, 1, 0])).toBe(0);

    datasource.manualReads[0].resolve();
    await idle();
    expect(gpu.classAt([5, 1, 0])).not.toBe(0);
  });

  it("leaves an unreadable chunk empty, logs, and fills the rest", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([5, 1, 0], SELECTED);
    datasource.setVoxel([1, 5, 0], SELECTED);
    datasource.failingKeys.add("1,0,0");
    const { preview, gpu, logger, idle } = makeHarness({ datasource });
    await idle();

    expect(gpu.classAt([5, 1, 0])).toBe(0);
    expect(gpu.classAt([1, 5, 0])).not.toBe(0);
    expect(logger.logs.some((log) => log.level === "warn")).toBe(true);
    const status = preview.status.value;
    expect(status.kind === "live" && status.fill).toEqual({
      done: REGION_CHUNK_COUNT,
      total: REGION_CHUNK_COUNT,
      failed: 1,
    });
  });

  it("shows the baseline and the edits made before it was enabled", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    const store = new LocalPatchStore();
    const chunk = store.source.getOrCreateChunk([1, 1, 0], CHUNK_SIZE);
    chunk.data[localIndexOf([6, 6, 0])] = PAINTED;
    chunk.patched[localIndexOf([6, 6, 0])] = 1;
    const { gpu, idle } = makeHarness({ datasource, store });
    await idle();

    expect(gpu.classAt([1, 1, 0])).not.toBe(0);
    expect(gpu.classAt([6, 6, 0])).not.toBe(0);
  });

  it("a new full recompute aborts the pass still reading", async () => {
    const datasource = new FakeDatasource();
    for (const key of ["0,0,0", "1,0,0", "0,1,0", "1,1,0"]) {
      datasource.deferredKeys.add(key);
    }
    const { segments } = makeHarness({ datasource });
    await settle();
    const firstPass = [...datasource.manualReads];
    expect(firstPass.length).toBeGreaterThan(0);

    segments.visibleSegments.add(OTHER);
    expect(firstPass.every((read) => read.signal.aborted)).toBe(true);
  });
});

describe("PaintedVolumePreview: unavailable", () => {
  it("reports a region no allowed downsampling fits, and allocates nothing", () => {
    const { preview, gpu } = makeHarness({ options: { budgetBytes: 0 } });
    expect(preview.status.value).toEqual({
      kind: "unavailable",
      reason: "region-too-large",
    });
    expect(gpu).toBeUndefined();
    expect(preview.renderLayer).toBeUndefined();
  });

  it("reports a texture the GPU refused", () => {
    const { preview, gpu } = makeHarness({ refuseAllocation: true });
    expect(preview.status.value).toEqual({
      kind: "unavailable",
      reason: "texture-allocation-failed",
    });
    expect(gpu.disposed).toBe(true);
    expect(preview.renderLayer).toBeUndefined();
  });

  it("reports the texture size and downsampling while live", () => {
    const { preview } = makeHarness();
    const status = preview.status.value;
    expect(status.kind).toBe("live");
    if (status.kind !== "live") return;
    expect(status.textureBytes).toBe(
      8 * 8 * 2 * PAINTED_VOLUME_BYTES_PER_TEXEL,
    );
    expect(status.factor).toEqual([1, 1, 1]);
  });
});

describe("PaintedVolumePreview: painting", () => {
  it("draws a stroke of a selected segment", async () => {
    const harness = makeHarness();
    await harness.idle();
    harness.paint([2, 3, 1], PAINTED);
    await harness.idle();
    expect(harness.gpu.classAt([2, 3, 1])).not.toBe(0);
    expect(harness.gpu.alphaOfClass(harness.gpu.classAt([2, 3, 1]))).toBe(255);
  });

  it("removes erased voxels of a selected segment", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([2, 3, 1], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    expect(harness.gpu.classAt([2, 3, 1])).not.toBe(0);

    harness.paint([2, 3, 1], 0n);
    await harness.idle();
    expect(harness.gpu.classAt([2, 3, 1])).toBe(0);
  });

  it("grows a selected segment painted with its own id", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([2, 3, 1], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();

    harness.paint([3, 3, 1], SELECTED);
    await harness.idle();
    expect(harness.gpu.classAt([3, 3, 1])).toBe(harness.gpu.classAt([2, 3, 1]));
  });

  it("undo through the mirror's change box restores the baseline", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([2, 3, 1], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    harness.paint([2, 3, 1], 0n);
    await harness.idle();

    const chunk = harness.store.source.getChunk([0, 0, 0])!;
    chunk.patched[localIndexOf([2, 3, 1])] = 0;
    chunk.data[localIndexOf([2, 3, 1])] = 0n;
    harness.store.noteChunkMutated([0, 0, 0], singleVoxelBox([2, 3, 1]));
    await harness.idle();
    expect(harness.gpu.classAt([2, 3, 1])).not.toBe(0);
  });

  it("clearChunk recomputes the chunk from its baseline, not zeros", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([2, 3, 1], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    harness.paint([2, 3, 1], 0n);
    await harness.idle();

    harness.store.clearChunk([0, 0, 0]);
    await harness.idle();
    expect(harness.gpu.classAt([2, 3, 1])).not.toBe(0);
  });

  it("clearAll recomputes the region from the clean baseline", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([2, 3, 1], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    harness.paint([2, 3, 1], 0n);
    harness.paint([6, 6, 0], PAINTED);
    await harness.idle();

    harness.store.clearAll();
    await harness.idle();
    expect(harness.gpu.classAt([2, 3, 1])).not.toBe(0);
    expect(harness.gpu.classAt([6, 6, 0])).toBe(0);
  });

  it("uploads once per chunk per frame, with the union of the boxes", async () => {
    const harness = makeHarness();
    await harness.idle();
    harness.gpu.uploads = [];
    harness.paint([1, 1, 0], PAINTED);
    harness.paint([2, 3, 1], PAINTED);
    await harness.idle();
    expect(harness.gpu.uploads).toEqual([
      { x0: 1, y0: 1, z0: 0, x1: 2, y1: 3, z1: 1 },
    ]);
  });

  it("works through a large change over several frames on its own", async () => {
    const harness = makeHarness({
      options: { voxelBudgetPerFrame: CHUNK_VOLUME },
    });
    await harness.idle();
    harness.gpu.uploads = [];
    for (const voxel of [
      [1, 1, 0],
      [5, 1, 0],
      [1, 5, 0],
      [5, 5, 0],
    ] as Triple[]) {
      const position = chunkPositionOf(voxel);
      const chunk = harness.store.source.getOrCreateChunk(position, CHUNK_SIZE);
      chunk.data[localIndexOf(voxel)] = PAINTED;
      chunk.patched[localIndexOf(voxel)] = 1;
      harness.store.noteChunkMutated(position);
    }
    // First frame: the painted chunks' baselines are not cached yet.
    await settle();
    frames.runFrame();
    expect(harness.gpu.uploads).toHaveLength(0);
    await settle();
    frames.runFrame();
    expect(harness.gpu.uploads).toHaveLength(1);
    await harness.idle();
    expect(harness.gpu.uploads).toHaveLength(4);
    expect(harness.gpu.classAt([5, 5, 0])).not.toBe(0);
  });

  it("handles a synchronous flushImmediately change on its own frame", async () => {
    const harness = makeHarness();
    await harness.idle();
    const position: Triple = [0, 0, 0];
    const data = new BigUint64Array(CHUNK_VOLUME).fill(PAINTED);
    harness.store.writeFullChunk(position, CHUNK_SIZE, data);
    harness.store.flushImmediately();
    await harness.idle();
    expect(harness.gpu.classAt([3, 3, 1])).not.toBe(0);
  });

  it("ignores changes to chunks outside the region", async () => {
    const harness = makeHarness();
    await harness.idle();
    harness.gpu.uploads = [];
    const reads = harness.datasource.readCountByKey.get("3,0,0") ?? 0;
    harness.paint([13, 1, 0], PAINTED);
    await harness.idle();
    expect(harness.gpu.uploads).toHaveLength(0);
    expect(harness.datasource.readCountByKey.get("3,0,0") ?? 0).toBe(reads);
  });

  it("reads a painted chunk's baseline once across strokes", async () => {
    const harness = makeHarness();
    await harness.idle();
    const readsAfterFill = harness.datasource.readCountByKey.get("0,0,0")!;
    harness.paint([1, 1, 0], PAINTED);
    await harness.idle();
    harness.paint([2, 1, 0], PAINTED);
    await harness.idle();
    expect(harness.datasource.readCountByKey.get("0,0,0")).toBe(
      readsAfterFill + 1,
    );
  });
});

describe("PaintedVolumePreview: shown segments", () => {
  it("shows a newly selected segment and hides a deselected one", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    datasource.setVoxel([6, 6, 1], OTHER);
    const harness = makeHarness({ datasource });
    await harness.idle();
    const selectedClass = harness.gpu.classAt([1, 1, 0]);

    harness.segments.visibleSegments.add(OTHER);
    harness.segments.visibleSegments.delete(SELECTED);
    // Hidden at once through the palette, before any recompute.
    expect(harness.gpu.alphaOfClass(selectedClass)).toBe(0);

    await harness.idle();
    expect(harness.gpu.classAt([1, 1, 0])).toBe(0);
    expect(harness.gpu.classAt([6, 6, 1])).not.toBe(0);
    expect(harness.gpu.alphaOfClass(harness.gpu.classAt([6, 6, 1]))).toBe(255);
  });

  it("does not draw a stroke of an unselected segment, as its mesh is not drawn", async () => {
    const harness = makeHarness();
    await harness.idle();
    harness.paint([6, 6, 1], OTHER);
    await harness.idle();
    expect(harness.gpu.classAt([6, 6, 1])).toBe(0);

    harness.segments.visibleSegments.add(OTHER);
    await harness.idle();
    expect(harness.gpu.classAt([6, 6, 1])).not.toBe(0);
  });

  it("highlights the hovered segment like its mesh, without recomputing", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    const selectedClass = harness.gpu.classAt([1, 1, 0]);
    const before = harness.gpu.rgbOfClass(selectedClass);
    harness.gpu.uploads = [];

    harness.segments.segmentSelectionState.set(SELECTED);
    expect(harness.gpu.rgbOfClass(selectedClass)).not.toEqual(before);
    harness.segments.segmentSelectionState.set(null);
    expect(harness.gpu.rgbOfClass(selectedClass)).toEqual(before);
    await harness.idle();
    expect(harness.gpu.uploads).toHaveLength(0);
  });

  it("draws nothing at a 3D opacity of 0, without recomputing", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    expect(harness.gpu.frame.visible).toBe(true);
    harness.gpu.uploads = [];

    harness.segments.objectAlpha.value = 0;
    expect(harness.gpu.frame.visible).toBe(false);
    harness.segments.objectAlpha.value = 0.5;
    expect(harness.gpu.frame.visible).toBe(true);
    await harness.idle();
    expect(harness.gpu.uploads).toHaveLength(0);
  });

  it("re-uploads the palette when a colour changes, without recomputing", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    harness.gpu.uploads = [];
    const paletteUploads = harness.gpu.paletteUploads;

    harness.segments.saturation.value = 0.5;
    expect(harness.gpu.paletteUploads).toBe(paletteUploads + 1);
    await harness.idle();
    expect(harness.gpu.uploads).toHaveLength(0);
  });

  it("onDatasourceRefetched redraws the region from the new bytes", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    harness.paint([2, 2, 0], PAINTED);
    await harness.idle();

    datasource.setVoxel([1, 1, 0], 0n);
    datasource.setVoxel([3, 3, 1], SELECTED);
    harness.preview.onDatasourceRefetched();
    await harness.idle();
    expect(harness.gpu.classAt([1, 1, 0])).toBe(0);
    expect(harness.gpu.classAt([3, 3, 1])).not.toBe(0);
    expect(harness.gpu.classAt([2, 2, 0])).not.toBe(0);

    // The painted chunk's cached baseline was dropped too.
    harness.paint([0, 0, 0], PAINTED);
    await harness.idle();
    expect(harness.gpu.classAt([1, 1, 0])).toBe(0);
  });
});

describe("PaintedVolumePreview: occupied box", () => {
  it("covers the chunks holding a shown voxel", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();
    expect(harness.gpu.frame.occupiedBox).toEqual({
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 3,
      y1: 3,
      z1: 1,
    });

    harness.paint([6, 6, 0], PAINTED);
    await harness.idle();
    expect(harness.gpu.frame.occupiedBox).toEqual({
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 7,
      y1: 7,
      z1: 1,
    });
  });

  it("keeps a partly erased chunk and drops a fully erased one", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    datasource.setVoxel([2, 1, 0], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();

    harness.paint([1, 1, 0], 0n);
    await harness.idle();
    expect(harness.gpu.frame.occupiedBox).toBeDefined();

    harness.paint([2, 1, 0], 0n);
    await harness.idle();
    expect(harness.gpu.frame.occupiedBox).toBeUndefined();
  });

  it("is empty once nothing is selected", async () => {
    const datasource = new FakeDatasource();
    datasource.setVoxel([1, 1, 0], SELECTED);
    const harness = makeHarness({ datasource });
    await harness.idle();

    harness.segments.visibleSegments.clear();
    await harness.idle();
    expect(harness.gpu.frame.occupiedBox).toBeUndefined();
  });
});

describe("PaintedVolumePreview: view", () => {
  it("keeps the cursor window in the frame state without touching the texture", async () => {
    const harness = makeHarness();
    await harness.idle();
    harness.gpu.uploads = [];
    const redraws = harness.gpu.redraws;

    harness.cursor.worldCenter.value = Float32Array.of(2.2, 3.7, 1.5) as vec3;
    harness.cursor.radiusVoxels.value = 2;
    harness.cursor.visible.value = true;
    expect(harness.gpu.frame.cursorFootprint).toEqual({
      anchorVoxel: [2, 3, 1],
      radiusSquared: 4.25,
    });
    expect(harness.gpu.redraws).toBeGreaterThan(redraws);

    harness.cursor.visible.value = false;
    expect(harness.gpu.frame.cursorFootprint).toBeUndefined();
    await harness.idle();
    expect(harness.gpu.uploads).toHaveLength(0);
  });

  it("rebuilds the texel-to-display matrix when the display scale changes", () => {
    const harness = makeHarness();
    const before = Array.from(harness.gpu.frame.texelToDisplay!);
    const redraws = harness.gpu.redraws;
    harness.displayInfo.value = makeDisplayInfo(20e-9);
    const after = Array.from(harness.gpu.frame.texelToDisplay!);
    // z: 40 nm voxels in 20 nm display units → 2 display units per texel.
    expect(before[10]).toBe(1);
    expect(after[10]).toBe(2);
    expect(harness.gpu.redraws).toBeGreaterThan(redraws);
  });
});

describe("PaintedVolumePreview: dispose", () => {
  it("stops reading, cancels its frame and frees the GPU", async () => {
    const datasource = new FakeDatasource();
    datasource.deferredKeys.add("0,0,0");
    const harness = makeHarness({ datasource });
    await settle();
    harness.preview.dispose();
    harnesses = harnesses.filter((other) => other !== harness);

    expect(datasource.manualReads[0].signal.aborted).toBe(true);
    expect(harness.gpu.disposed).toBe(true);
    harness.paint([1, 1, 0], PAINTED);
    await harness.idle();
    expect(harness.gpu.uploads).toHaveLength(0);
    harness.store.dispose();
  });
});
