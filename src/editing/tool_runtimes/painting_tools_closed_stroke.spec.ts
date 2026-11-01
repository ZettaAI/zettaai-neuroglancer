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
 * The stroke tool end to end over the real `PaintingCompute`, against an `Edit`
 * that keeps the voxels it is given, so these assert what ends up painted.
 * Worker-path parity lives in `paint_stroke_pipeline.spec.ts`; Node is not
 * cross-origin isolated, so everything here takes the synchronous path.
 */

import type {
  ChunkId,
  Edit,
  EditMeta,
  EditSession,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  VoxelDataType,
} from "@zettaai/edit-session";
import { layerId, Resolution as ResolutionCtor } from "@zettaai/edit-session";
import { describe, it, expect, vi } from "vitest";

import type { PaintCompute } from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";
import {
  ConsumerPaintingTools,
  type PaintingSharedState,
} from "#src/editing/tool_runtimes/painting_tools.js";
import type { ToolInputEvent } from "#src/editing/tool_runtimes/tool_input.js";
import { NO_MODIFIERS } from "#src/editing/tool_runtimes/tool_input.js";
import { EditScope } from "#src/editing/tooling/edit_scope.js";

const RESOLUTION: Resolution = ResolutionCtor.from([8, 8, 40]);
const TARGET: LayerId = layerId("target");
const IMAGE: LayerId = layerId("image");
const CHUNK = 32;
const VOLUME = 256;
const Z = 5;
const VALUE = 7;
const LOOP_CENTER = 60;

function metadataFor(
  id: LayerId,
  voxelDataType: VoxelDataType,
  chunk = CHUNK,
): LayerMetadata {
  return {
    layerId: id,
    voxelDataType,
    channels: 1,
    scales: [
      {
        resolution: RESOLUTION,
        voxelSizeNm: [8, 8, 40],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [VOLUME, VOLUME, VOLUME],
        chunkDataSize: [chunk, chunk, chunk],
      },
    ],
  };
}

type VoxelStore = Map<string, number | bigint>;
const voxelKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

interface WrittenBox {
  readonly origin: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

interface Harness {
  readonly tools: ConsumerPaintingTools;
  readonly scope: EditScope;
  readonly stores: VoxelStore[];
  readonly metas: EditMeta[];
  readonly notices: string[];
  readonly lifecycle: { records: number; discards: number };
  /** Awaited inside each region write, so a test can interleave events. */
  beforeWrite: (box: WrittenBox) => Promise<void>;
  /** Awaited inside each `beginWrite`, the step a fill's target reads go through. */
  beforeBeginWrite: () => Promise<void>;
  /** Replays the last entry's redo onto a fresh store. */
  redo(index?: number): Promise<VoxelStore>;
}

function makeEdit(harness: Harness, store: VoxelStore, record: boolean): Edit {
  return {
    readChunk: async () =>
      ({
        byteLength: 0,
        asView: () => new Uint32Array(0),
      }) as ReadonlyChunkVoxelBuffer,
    beginWrite: async () => {
      await harness.beforeBeginWrite();
      return {} as never;
    },
    commitWrites: () => {},
    writeRegion: async (
      _target: unknown,
      dense: unknown,
      box: WrittenBox,
      options?: { valueMask?: Uint8Array },
    ) => {
      await harness.beforeWrite(box);
      const [originX, originY, originZ] = box.origin;
      const [sizeX, sizeY] = box.size;
      const values = dense as Uint32Array;
      for (let row = 0; row < sizeY; row++) {
        for (let column = 0; column < sizeX; column++) {
          const index = row * sizeX + column;
          if (options?.valueMask?.[index] === 0) continue;
          store.set(
            voxelKey(originX + column, originY + row, originZ),
            values[index],
          );
        }
      }
    },
    readRegion: async () => {
      throw new Error("not used");
    },
    sessionVoxelBoundsFor: () => ({
      loX: 0,
      loY: 0,
      loZ: 0,
      hiX: VOLUME,
      hiY: VOLUME,
      hiZ: VOLUME,
    }),
    withBatch: <R>(fn: () => R): R => fn(),
    record: () => {
      if (record) harness.lifecycle.records++;
      return true;
    },
    discard: async () => {
      harness.lifecycle.discards++;
    },
  } as unknown as Edit;
}

interface SetupOptions {
  state?: Partial<PaintingSharedState>;
  imageType?: VoxelDataType;
  chunk?: number;
  readChunkAt?: ConsumerPaintingToolsOptions["readChunkAt"];
  compute?: PaintCompute;
}
type ConsumerPaintingToolsOptions = ConstructorParameters<
  typeof ConsumerPaintingTools
>[0];

function setup(options: SetupOptions = {}): Harness {
  const harness = {
    stores: [],
    metas: [],
    notices: [],
    lifecycle: { records: 0, discards: 0 },
    beforeWrite: async () => {},
    beforeBeginWrite: async () => {},
  } as unknown as { -readonly [K in keyof Harness]: Harness[K] };
  const session = {
    beginEdit: (meta: EditMeta) => {
      const store: VoxelStore = new Map();
      harness.stores.push(store);
      harness.metas.push(meta);
      return makeEdit(harness, store, true);
    },
  } as unknown as EditSession;
  harness.scope = new EditScope(session);
  harness.redo = async (index = harness.metas.length - 1) => {
    const redo = harness.metas[index].redo;
    if (redo?.kind !== "replay") throw new Error("not a replay entry");
    const store: VoxelStore = new Map();
    await redo.reapply(makeEdit(harness, store, false));
    return store;
  };
  const metadataByLayer = new Map<LayerId, LayerMetadata>([
    [TARGET, metadataFor(TARGET, "uint32", options.chunk)],
    [IMAGE, metadataFor(IMAGE, options.imageType ?? "uint8")],
  ]);
  harness.tools = new ConsumerPaintingTools({
    scope: harness.scope,
    compute: options.compute ?? new PaintingCompute(),
    metadataByLayer,
    allowedResolutionsByLayer: new Map([
      [TARGET, [RESOLUTION]],
      [IMAGE, [RESOLUTION]],
    ]),
    readChunkAt:
      options.readChunkAt ??
      (async () => ({
        byteLength: CHUNK ** 3,
        asView: () => new Uint8Array(CHUNK ** 3),
      })),
    initialState: {
      targetLayerId: TARGET,
      targetResolution: RESOLUTION,
      radius: 2,
      radiusCycle: [1, 2, 3],
      activeValue: VALUE,
      eraseValue: 0,
      mask: undefined,
      fillMode: "2d",
      spacingFraction: 0.1,
      autoSelectPaintedSegment: false,
      fillClosedPaths: true,
      ...options.state,
    },
    notify: (message) => harness.notices.push(message),
  });
  return harness as Harness;
}

const base = { at: 0, modifiers: NO_MODIFIERS };
const pointer = (x: number, y: number) => ({
  button: "primary" as const,
  voxelPosition: [x, y, Z] as const,
  screenPosition: [0, 0] as const,
  panelHint: undefined,
  ...base,
});
const down = (x: number, y: number): ToolInputEvent => ({
  kind: "pointer-down",
  ...pointer(x, y),
});
const up = (x: number, y: number): ToolInputEvent =>
  ({
    kind: "pointer-up",
    button: "primary",
    voxelPosition: [x, y, Z],
    ...base,
  }) as ToolInputEvent;
const move = (
  x: number,
  y: number,
  contourVoxelPositions?: readonly (readonly [number, number, number])[],
): ToolInputEvent => ({
  kind: "pointer-move",
  ...pointer(x, y),
  ...(contourVoxelPositions !== undefined ? { contourVoxelPositions } : {}),
});

/** A square outline around the center, drawn with small steps. */
function loopPoints(halfSide = 20): [number, number][] {
  const low = LOOP_CENTER - halfSide;
  const high = LOOP_CENTER + halfSide;
  const points: [number, number][] = [];
  for (let x = low; x <= high; x += 2) points.push([x, low]);
  for (let y = low; y <= high; y += 2) points.push([high, y]);
  for (let x = high; x >= low; x -= 2) points.push([x, high]);
  for (let y = high; y >= low; y -= 2) points.push([low, y]);
  return points;
}

async function drawLoop(harness: Harness, halfSide?: number): Promise<void> {
  const points = loopPoints(halfSide);
  const brush = harness.tools.brush;
  await brush.handleInput(down(points[0][0], points[0][1]));
  for (const [x, y] of points.slice(1)) await brush.handleInput(move(x, y));
  const [lastX, lastY] = points[points.length - 1];
  await brush.handleInput(up(lastX, lastY));
}

/**
 * Whether a write reaches the middle of the loop. Only the fill does: the stroke
 * stays on the outline, and pointer-up paints the stroke's tail before the fill.
 */
const writesLoopCenter = ({ origin, size }: WrittenBox) =>
  origin[0] <= LOOP_CENTER &&
  LOOP_CENTER < origin[0] + size[0] &&
  origin[1] <= LOOP_CENTER &&
  LOOP_CENTER < origin[1] + size[1];

/** Hold the fill at its write to the loop's middle until `blocked` opens. */
function holdFillWrite(harness: Harness) {
  const blocked = gate();
  const reached = gate();
  harness.beforeWrite = async (box) => {
    if (!writesLoopCenter(box)) return;
    reached.open();
    await blocked.promise;
  };
  return { blocked, reached };
}

const paintedAtCenter = (store: VoxelStore) =>
  store.get(voxelKey(LOOP_CENTER, LOOP_CENTER, Z));

const sortedEntries = (store: VoxelStore) =>
  [...store.entries()].sort(([a], [b]) => a.localeCompare(b));

/** A promise a test settles by hand. */
function gate<T = void>() {
  let open!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

describe("StrokeTool closed-stroke fill (TM-268)", () => {
  it("fills a closed stroke as part of one undo entry", async () => {
    const harness = setup();
    await drawLoop(harness);
    expect(paintedAtCenter(harness.stores[0])).toBe(VALUE);
    expect(harness.stores[0].has(voxelKey(10, 10, Z))).toBe(false);
    expect(harness.metas).toHaveLength(1);
    expect(harness.lifecycle.records).toBe(1);
    expect(harness.scope.hasLiveEdit).toBe(false);
    expect(harness.notices).toEqual([]);
  });

  it("paints exactly the plain stroke when the toggle is off", async () => {
    const on = setup();
    const off = setup({ state: { fillClosedPaths: false } });
    await drawLoop(off);
    await drawLoop(on);
    expect(paintedAtCenter(off.stores[0])).toBeUndefined();
    for (const [key, value] of off.stores[0]) {
      expect(on.stores[0].get(key)).toBe(value);
    }
  });

  it("does not change an open stroke", async () => {
    const on = setup();
    const off = setup({ state: { fillClosedPaths: false } });
    for (const harness of [on, off]) {
      const brush = harness.tools.brush;
      await brush.handleInput(down(20, 20));
      for (let x = 22; x <= 60; x += 2) await brush.handleInput(move(x, 20));
      await brush.handleInput(up(60, 20));
    }
    expect(sortedEntries(on.stores[0])).toEqual(sortedEntries(off.stores[0]));
    expect(on.notices).toEqual([]);
  });

  it("never fills with the eraser", async () => {
    const harness = setup();
    const { erase } = harness.tools;
    const points = loopPoints();
    await erase.handleInput(down(points[0][0], points[0][1]));
    for (const [x, y] of points.slice(1)) await erase.handleInput(move(x, y));
    await erase.handleInput(up(points[0][0], points[0][1]));
    expect(paintedAtCenter(harness.stores[0])).toBeUndefined();
  });

  it("uses dropped pointer samples to find the enclosure", async () => {
    const harness = setup();
    const brush = harness.tools.brush;
    const points = loopPoints().map(
      ([x, y]) => [x, y, Z] as [number, number, number],
    );
    await brush.handleInput(down(points[0][0], points[0][1]));
    // Painted positions alone are collinear; only the dropped samples close it.
    await brush.handleInput(move(points[0][0], points[0][1], points.slice(1)));
    await brush.handleInput(up(points[0][0], points[0][1]));
    expect(paintedAtCenter(harness.stores[0])).toBe(VALUE);
  });

  it("redo reproduces the stroke and its fill byte for byte", async () => {
    const harness = setup();
    await drawLoop(harness);
    const redone = await harness.redo();
    expect(sortedEntries(redone)).toEqual(sortedEntries(harness.stores[0]));
  });

  it("a fill skipped as too large keeps the stroke, says so, and stays skipped on redo", async () => {
    const harness = setup();
    const brush = harness.tools.brush;
    // 1400² inside: past the interior limit.
    await brush.handleInput(down(-640, -640));
    await brush.handleInput(move(760, -640));
    await brush.handleInput(move(760, 760));
    await brush.handleInput(move(-640, 760));
    await brush.handleInput(move(-640, -640));
    await brush.handleInput(up(-640, -640));
    expect(paintedAtCenter(harness.stores[0])).toBeUndefined();
    expect(harness.notices).toEqual([
      "The stroke was kept, but the area inside it is too large to fill.",
    ]);
    expect(harness.lifecycle.records).toBe(1);
    expect(paintedAtCenter(await harness.redo())).toBeUndefined();
  });

  it("a fill over the history budget keeps the stroke and says so", async () => {
    // 512-voxel chunks of uint32: 512 MiB each, past the budget at one tile.
    const harness = setup({ chunk: 512 });
    await drawLoop(harness);
    expect(paintedAtCenter(harness.stores[0])).toBeUndefined();
    expect(harness.stores[0].size).toBeGreaterThan(0);
    expect(harness.notices).toEqual([
      "The stroke was kept, but the area inside it is too large to fill.",
    ]);
    expect(harness.lifecycle.records).toBe(1);
    expect(paintedAtCenter(await harness.redo())).toBeUndefined();
  });

  it("a failing fill still commits the stroke and frees the edit", async () => {
    const harness = setup();
    const points = loopPoints();
    const brush = harness.tools.brush;
    await brush.handleInput(down(points[0][0], points[0][1]));
    for (const [x, y] of points.slice(1)) await brush.handleInput(move(x, y));
    harness.beforeWrite = async (box) => {
      if (writesLoopCenter(box)) throw new Error("write failed");
    };
    await brush.handleInput(up(points[0][0], points[0][1]));
    expect(harness.lifecycle.records).toBe(1);
    expect(harness.scope.hasLiveEdit).toBe(false);
    expect(harness.notices).toEqual([
      "The stroke was kept, but the area inside it could not be filled.",
    ]);
    // Redo must not gain a fill the original never finished.
    harness.beforeWrite = async () => {};
    expect(paintedAtCenter(await harness.redo())).toBeUndefined();
  });

  it("a tool switch during the fill stops its writes and rolls back", async () => {
    const harness = setup();
    const points = loopPoints();
    const brush = harness.tools.brush;
    await brush.handleInput(down(points[0][0], points[0][1]));
    for (const [x, y] of points.slice(1)) await brush.handleInput(move(x, y));
    const { blocked, reached } = holdFillWrite(harness);
    const finishing = brush.handleInput(up(points[0][0], points[0][1]));
    await reached.promise;
    brush.onDeactivate();
    blocked.open();
    await finishing;
    expect(harness.lifecycle.discards).toBe(1);
    expect(harness.lifecycle.records).toBe(0);
    expect(harness.scope.hasLiveEdit).toBe(false);
    // The one write already past its guard landed; the batch stops there, so
    // the interior of a later chunk stays untouched.
    expect(
      harness.stores[0].has(voxelKey(LOOP_CENTER + 10, LOOP_CENTER + 10, Z)),
    ).toBe(false);
  });

  it("the next stroke waits for the fill instead of being dropped", async () => {
    const harness = setup();
    const points = loopPoints();
    const brush = harness.tools.brush;
    await brush.handleInput(down(points[0][0], points[0][1]));
    for (const [x, y] of points.slice(1)) await brush.handleInput(move(x, y));
    const { blocked, reached } = holdFillWrite(harness);
    const finishing = brush.handleInput(up(points[0][0], points[0][1]));
    await reached.promise;
    // A move arriving now must not reach the edit being filled.
    await brush.handleInput(move(200, 200));
    expect(harness.stores[0].has(voxelKey(200, 200, Z))).toBe(false);
    const nextDown = brush.handleInput(down(200, 200));
    expect(harness.metas).toHaveLength(1);
    blocked.open();
    harness.beforeWrite = async () => {};
    await finishing;
    await nextDown;
    expect(harness.lifecycle.records).toBe(1);
    expect(harness.metas).toHaveLength(2);
    expect(harness.stores[1].get(voxelKey(200, 200, Z))).toBe(VALUE);
    await brush.handleInput(up(200, 200));
    expect(harness.lifecycle.records).toBe(2);
  });

  it("a stroke waiting on a fill is dropped if the tool is switched away", async () => {
    const harness = setup();
    const points = loopPoints();
    const brush = harness.tools.brush;
    await brush.handleInput(down(points[0][0], points[0][1]));
    for (const [x, y] of points.slice(1)) await brush.handleInput(move(x, y));
    const { blocked, reached } = holdFillWrite(harness);
    const finishing = brush.handleInput(up(points[0][0], points[0][1]));
    await reached.promise;
    const nextDown = brush.handleInput(down(200, 200));
    brush.onDeactivate();
    blocked.open();
    await finishing;
    await nextDown;
    expect(harness.metas).toHaveLength(1);
    expect(harness.scope.hasLiveEdit).toBe(false);
  });
});

describe("StrokeTool closed-stroke fill under an image mask (TM-268)", () => {
  const fullRangeMask = {
    imageLayerId: IMAGE,
    imageResolution: RESOLUTION,
    thresholdLow: 0,
    thresholdHigh: 255,
    minComponentSize: 0,
    binaryClosing: 0,
    filterComponentsFirst: false,
  };

  it("a mask that rejects nothing skips the image and redoes by replay", async () => {
    const readChunkAt = vi.fn();
    const harness = setup({ state: { mask: fullRangeMask }, readChunkAt });
    await drawLoop(harness);
    expect(readChunkAt).not.toHaveBeenCalled();
    expect(harness.metas[0].redo?.kind).toBe("replay");
    expect(paintedAtCenter(harness.stores[0])).toBe(VALUE);
  });

  it("the same mask with the toggle off stays masked, as before", async () => {
    const readChunkAt = vi.fn(async () => ({
      byteLength: CHUNK ** 3,
      asView: () => new Uint8Array(CHUNK ** 3),
    }));
    const harness = setup({
      state: { mask: fullRangeMask, fillClosedPaths: false },
      readChunkAt,
    });
    await drawLoop(harness);
    expect(readChunkAt).toHaveBeenCalled();
    expect(harness.metas[0].redo?.kind).toBe("image");
  });

  it("does not treat a full-range float32 mask as rejecting nothing", async () => {
    const readChunkAt = vi.fn(async () => ({
      byteLength: 4 * CHUNK ** 3,
      asView: () => new Float32Array(CHUNK ** 3),
    }));
    const harness = setup({
      imageType: "float32",
      state: {
        mask: {
          ...fullRangeMask,
          thresholdLow: -Number.MAX_VALUE,
          thresholdHigh: Number.MAX_VALUE,
        },
      },
      readChunkAt,
    });
    await drawLoop(harness);
    expect(readChunkAt).toHaveBeenCalled();
    expect(harness.metas[0].redo?.kind).toBe("image");
  });

  /** An image whose voxels are 200 left of `LOOP_CENTER`, and 0 from it on. */
  const halfBrightImage = async (
    _layer: LayerId,
    _resolution: Resolution,
    chunkId: ChunkId,
  ) => {
    const coordinates = String(chunkId).match(/-?\d+/g)!.map(Number);
    const chunkX = coordinates[coordinates.length - 3];
    const view = new Uint8Array(CHUNK ** 3);
    for (let i = 0; i < view.length; i++) {
      const x = chunkX * CHUNK + (i % CHUNK);
      view[i] = x < LOOP_CENTER ? 200 : 0;
    }
    return { byteLength: view.length, asView: () => view };
  };
  const brightOnlyMask = { ...fullRangeMask, thresholdLow: 100 };

  it("passes the fill through a real threshold", async () => {
    const harness = setup({
      state: { mask: brightOnlyMask },
      readChunkAt: halfBrightImage,
    });
    await drawLoop(harness);
    const store = harness.stores[0];
    expect(store.get(voxelKey(LOOP_CENTER - 5, LOOP_CENTER, Z))).toBe(VALUE);
    expect(store.has(voxelKey(LOOP_CENTER + 5, LOOP_CENTER, Z))).toBe(false);
    expect(harness.metas[0].redo?.kind).toBe("image");
  });

  it("skips a masked fill whole when a target chunk cannot be read", async () => {
    const harness = setup({
      state: { mask: brightOnlyMask },
      readChunkAt: halfBrightImage,
    });
    harness.beforeBeginWrite = async () => {
      throw new Error("target unavailable");
    };
    await drawLoop(harness);
    expect(
      harness.stores[0].has(voxelKey(LOOP_CENTER - 5, LOOP_CENTER, Z)),
    ).toBe(false);
    expect(harness.notices).toEqual([
      "The stroke was kept, but the area inside it could not be filled.",
    ]);
    expect(harness.lifecycle.records).toBe(1);
  });

  it("skips the fill when an image read fails, rather than cutting a hole", async () => {
    let reads = 0;
    let failing = false;
    const readChunkAt = async (
      layer: LayerId,
      resolution: Resolution,
      chunkId: ChunkId,
    ) => {
      reads++;
      if (failing) throw new Error("image unavailable");
      return halfBrightImage(layer, resolution, chunkId);
    };
    const harness = setup({
      state: { mask: brightOnlyMask },
      readChunkAt,
    });
    const points = loopPoints(40);
    const brush = harness.tools.brush;
    await brush.handleInput(down(points[0][0], points[0][1]));
    for (const [x, y] of points.slice(1)) await brush.handleInput(move(x, y));
    // The stroke only read chunks under its outline, so the interior chunk is
    // not cached and the fill has to read it.
    failing = true;
    await brush.handleInput(up(points[0][0], points[0][1]));
    expect(reads).toBeGreaterThan(0);
    expect(
      harness.stores[0].has(voxelKey(LOOP_CENTER - 5, LOOP_CENTER, Z)),
    ).toBe(false);
    expect(harness.notices).toEqual([
      "The stroke was kept, but the area inside it could not be filled.",
    ]);
    expect(harness.lifecycle.records).toBe(1);
  });
});

describe("StrokeTool lifecycle guards (toggle off)", () => {
  const off = { state: { fillClosedPaths: false } };

  it("a tail that fails still commits, so later strokes are not ignored", async () => {
    const real = new PaintingCompute();
    let fail = false;
    const compute: PaintCompute = {
      applyBrush: (input) => real.applyBrush(input),
      fill: (input) => real.fill(input),
      applyBrushStroke: (input) =>
        fail
          ? Promise.reject(new Error("compute failed"))
          : real.applyBrushStroke(input),
    };
    // Short moves under a wide spacing emit no stamps, so pointer-up has a tail.
    const harness = setup({
      state: { fillClosedPaths: false, spacingFraction: 1 },
      compute,
    });
    const brush = harness.tools.brush;
    await brush.handleInput(down(10, 10));
    await brush.handleInput(move(11, 10));
    await brush.handleInput(move(12, 10));
    fail = true;
    await expect(brush.handleInput(up(12, 10))).rejects.toThrow(
      "compute failed",
    );
    expect(harness.lifecycle.records).toBe(1);
    expect(harness.scope.hasLiveEdit).toBe(false);
    fail = false;
    await brush.handleInput(down(50, 50));
    expect(harness.metas).toHaveLength(2);
  });

  it("does not write a segment canceled while its compute was running", async () => {
    const real = new PaintingCompute();
    const computing = gate();
    const started = gate();
    const compute: PaintCompute = {
      applyBrush: (input) => real.applyBrush(input),
      fill: (input) => real.fill(input),
      applyBrushStroke: async (input) => {
        started.open();
        await computing.promise;
        return real.applyBrushStroke(input);
      },
    };
    const harness = setup({ ...off, compute });
    const brush = harness.tools.brush;
    await brush.handleInput(down(10, 10));
    const painted = harness.stores[0].size;
    const segment = brush.handleInput(move(30, 10));
    await started.promise;
    brush.onDeactivate();
    computing.open();
    await segment;
    expect(harness.stores[0].size).toBe(painted);
    expect(harness.lifecycle.discards).toBe(1);
  });

  it("stops a batch at the next chunk when canceled between chunks", async () => {
    const harness = setup(off);
    const brush = harness.tools.brush;
    await brush.handleInput(down(30, 10));
    const blocked = gate();
    const reached = gate();
    let writes = 0;
    harness.beforeWrite = async () => {
      writes++;
      reached.open();
      await blocked.promise;
    };
    // Crosses the chunk boundary at x=32, so the batch has at least two writes.
    const segment = brush.handleInput(move(34, 10));
    await reached.promise;
    brush.onDeactivate();
    blocked.open();
    await segment;
    expect(writes).toBe(1);
  });
});
