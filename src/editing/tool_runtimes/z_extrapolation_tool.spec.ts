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
  Edit,
  EditSession,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  ScaleMetadata,
  VoxelBox,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdCodec,
  layerId,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_TRACKED_SEGMENTS } from "#src/editing/tool_runtimes/mask_label_codec.js";
import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";
import type { MultipartPoster } from "#src/editing/tool_runtimes/propagate_mask_client.js";
import { ZExtrapolationTool } from "#src/editing/tool_runtimes/z_extrapolation_tool.js";
import type { EditScope } from "#src/editing/tooling/edit_scope.js";
import { StatusMessage } from "#src/status.js";

const IMAGE: LayerId = layerId("image");
const MASK: LayerId = layerId("mask");
const RES: Resolution = ResolutionCtor.from([8, 8, 8]);
/** Chunks one voxel deep in Z, so every slice is its own chunk read. */
const SCALE: ScaleMetadata = {
  resolution: RES,
  voxelSizeNm: [8, 8, 8],
  voxelOffset: [0, 0, 0],
  sizeVoxels: [2, 2, 20],
  chunkDataSize: [2, 2, 1],
};
const BOUNDS = { loX: 0, loY: 0, loZ: 0, hiX: 2, hiY: 2, hiZ: 20 };
/** The current-slice mask the session returns: two segments, 100 and 200. */
const CURRENT_MASK = BigUint64Array.from([100n, 100n, 200n, 0n]);
/** The next slice before a run: segment 200 already owns the last two voxels. */
const NEXT_MASK = BigUint64Array.from([0n, 0n, 200n, 200n]);

function metadata(id: LayerId, dataType: "uint8" | "uint64"): LayerMetadata {
  return { layerId: id, voxelDataType: dataType, channels: 1, scales: [SCALE] };
}

/** Image chunk reader recording which slice (chunk Z) each read was for. */
function recordingImageReader() {
  const readZs: number[] = [];
  const reader: ReadChunkAt = (
    _layer: LayerId,
    _resolution: Resolution,
    chunkId: ChunkId,
  ) => {
    const { z } = ChunkIdCodec.toCoord(chunkId);
    readZs.push(z);
    const view = new Uint8Array(4).fill(z);
    const buffer: ReadonlyChunkVoxelBuffer = {
      byteLength: view.byteLength,
      asView: () => view,
    };
    return Promise.resolve(buffer);
  };
  return { reader, readZs };
}

/** A Blob's bytes (this environment's Blob has no `arrayBuffer()`). */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Backend predicting one label everywhere; records the labelized mask sent. */
function recordingBackend(predictedLabel = 1) {
  const sentMasks: Uint8Array[] = [];
  const client: MultipartPoster = {
    async postMultipart(_path, form) {
      sentMasks.push(await blobBytes(form.get("mask-data") as Blob));
      const header = new TextEncoder().encode(
        JSON.stringify({ mask_shape: [2, 2] }),
      );
      const body = new Uint8Array(4 + header.length + 4);
      new DataView(body.buffer).setUint32(0, header.length, true);
      body.set(header, 4);
      body.fill(predictedLabel, 4 + header.length);
      return new Response(body);
    },
  };
  return { client, sentMasks };
}

function makeTool(
  options: {
    listed?: bigint[];
    hidden?: bigint[];
    merged?: bigint[];
    currentMask?: BigUint64Array;
    predictedLabel?: number;
  } = {},
) {
  const currentMask = options.currentMask ?? CURRENT_MASK;
  const listed = [...(options.listed ?? [100n, 200n])];
  const hidden = new Set(options.hidden ?? []);
  const merged = new Set(options.merged ?? []);
  const shown: bigint[] = [];
  const removalListeners = new Set<(ids: readonly bigint[] | "all") => void>();
  /** Deselect in the viewer: drop from the list and tell the subscribers. */
  const deselect = (ids: readonly bigint[] | "all") => {
    if (ids === "all") listed.splice(0);
    else for (const id of ids) listed.splice(listed.indexOf(id), 1);
    for (const listener of removalListeners) listener(ids);
  };
  const writes: { box: VoxelBox; dense: unknown; valueMask?: Uint8Array }[] =
    [];
  const edit = {
    readRegion: (_target: unknown, box: VoxelBox) =>
      Promise.resolve({
        box,
        data: box.origin[2] === 5 ? currentMask : NEXT_MASK,
      }),
    writeRegion: (
      _target: unknown,
      dense: unknown,
      box: VoxelBox,
      options?: { valueMask?: Uint8Array },
    ) => {
      writes.push({ box, dense, valueMask: options?.valueMask });
      return Promise.resolve();
    },
    discard: () => Promise.resolve(),
  } as unknown as Edit;
  const session = {
    sessionVoxelBoundsFor: () => BOUNDS,
    beginEdit: () => edit,
    undo: () => Promise.resolve(),
  } as unknown as EditSession;
  const scope = {
    runOperation: (_meta: unknown, operation: (edit: Edit) => Promise<void>) =>
      operation(edit),
  } as unknown as EditScope;
  const image = recordingImageReader();
  const backend = recordingBackend(options.predictedLabel);
  let viewport: Float32Array = Float32Array.from([1, 1, 5.5]);
  const tool = new ZExtrapolationTool({
    session,
    scope,
    backendClient: backend.client,
    readChunkAt: image.reader,
    metadataByLayer: new Map([
      [IMAGE, metadata(IMAGE, "uint8")],
      [MASK, metadata(MASK, "uint64")],
    ]),
    resolutionFor: () => RES,
    globalVoxelSizeNm: () => [8, 8, 8],
    listedSegmentsFor: () => listed,
    isSegmentVisible: (_layer, id) => !hidden.has(id),
    isMergedSegment: (_layer, id) => merged.has(id),
    showSegments: (_layer, ids) => {
      shown.push(...ids);
      for (const id of ids) if (!listed.includes(id)) listed.push(id);
    },
    onListedSegmentsRemoved: (_layer, onRemoved) => {
      removalListeners.add(onRemoved);
      return () => removalListeners.delete(onRemoved);
    },
    getViewportPosition: () => viewport,
    setViewportPosition: (position) => {
      viewport = position;
    },
  });
  tool.setImageLayer(IMAGE);
  tool.setMaskLayer(MASK);
  return {
    tool,
    listed,
    shown,
    deselect,
    removalListeners,
    writes,
    readZs: image.readZs,
    /** The viewport's global Z (one global unit = one mask voxel here). */
    viewportZ: () => viewport[2],
    /** The user scrolling the viewer to global Z `z`. */
    scrollTo: (z: number) => {
      viewport = Float32Array.from([viewport[0], viewport[1], z]);
    },
    /** The user scrolling the viewer to the centre of mask slice `z`. */
    goToSlice: (z: number) => {
      viewport = Float32Array.from([viewport[0], viewport[1], z + 0.5]);
      tool.followViewportZ();
    },
    ...backend,
  };
}

/** Let fire-and-forget work (a prefetch) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ZExtrapolationTool tracking (TM-518)", () => {
  it("tracks every listed segment by default", () => {
    const { tool } = makeTool();
    expect(tool.segmentRows()).toEqual([
      { id: 100n, isTracked: true, isHidden: false, isMerged: false },
      { id: 200n, isTracked: true, isHidden: false, isMerged: false },
    ]);
    expect(tool.trackedSegments()).toEqual([100n, 200n]);
  });

  it("marks a selected segment hidden in the viewer, still tracked", () => {
    const { tool } = makeTool({ hidden: [200n] });
    expect(tool.segmentRows()[1]).toEqual({
      id: 200n,
      isTracked: true,
      isHidden: true,
      isMerged: false,
    });
  });

  it("untracks one segment without touching the listed segments", () => {
    const { tool, listed } = makeTool();
    const changed = vi.fn();
    tool.changed.add(changed);
    tool.setSegmentTracked(200n, false);
    expect(tool.trackedSegments()).toEqual([100n]);
    expect(tool.segmentRows()[1].isTracked).toBe(false);
    expect(listed).toEqual([100n, 200n]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("does not signal a change when tracking is already as asked", () => {
    const { tool } = makeTool();
    const changed = vi.fn();
    tool.changed.add(changed);
    tool.setSegmentTracked(100n, true);
    expect(changed).not.toHaveBeenCalled();
  });

  it("tracks a segment again", () => {
    const { tool } = makeTool();
    tool.setSegmentTracked(200n, false);
    tool.setSegmentTracked(200n, true);
    expect(tool.trackedSegments()).toEqual([100n, 200n]);
  });

  it("untracks and tracks every segment at once", () => {
    const { tool } = makeTool();
    tool.setAllSegmentsTracked(false);
    expect(tool.trackedSegments()).toEqual([]);
    tool.setAllSegmentsTracked(true);
    expect(tool.trackedSegments()).toEqual([100n, 200n]);
  });

  it("forgets the untick of a segment that leaves the list", () => {
    const { tool, listed, deselect } = makeTool();
    tool.setSegmentTracked(200n, false);
    deselect([200n]);
    listed.push(200n); // selected again before anything re-read the rows
    expect(tool.trackedSegments()).toEqual([100n, 200n]);
  });

  it("forgets every untick when the list is cleared", () => {
    const { tool, listed, deselect } = makeTool();
    tool.setAllSegmentsTracked(false);
    deselect("all");
    listed.push(100n, 200n);
    expect(tool.trackedSegments()).toEqual([100n, 200n]);
  });

  it("reads rows without changing tracking state", () => {
    const { tool, listed } = makeTool();
    tool.setSegmentTracked(200n, false);
    const changed = vi.fn();
    tool.changed.add(changed);
    listed.splice(1, 1); // gone without a removal event
    tool.segmentRows();
    tool.runDisabledReason();
    listed.push(200n);
    // No event said 200 left, so its untick stands; reading changed nothing.
    expect(tool.trackedSegments()).toEqual([100n]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("drops its selection subscriptions on dispose", () => {
    const { tool, removalListeners } = makeTool();
    tool.setSegmentTracked(200n, false);
    expect(removalListeners.size).toBe(1);
    tool.dispose();
    expect(removalListeners.size).toBe(0);
  });

  it("keeps tracking per segmentation layer", () => {
    const { tool } = makeTool();
    tool.setSegmentTracked(200n, false);
    tool.setMaskLayer(layerId("other-mask"));
    expect(tool.trackedSegments()).toEqual([100n, 200n]);
  });

  it("shows and tracks auto-detected segments, even ones unticked before", async () => {
    const { tool, listed, shown } = makeTool({ listed: [200n] });
    tool.setSegmentTracked(200n, false);
    await tool.autoDetectTrackedSegments();
    expect(shown).toEqual([100n, 200n]);
    expect(listed).toEqual([200n, 100n]);
    expect(tool.trackedSegments()).toEqual([200n, 100n]);
  });

  it("asks before auto-detect tracks more than one run carries", async () => {
    const alreadyListed = Array.from(
      { length: MAX_TRACKED_SEGMENTS - 1 },
      (_, i) => BigInt(1000 + i),
    );
    const { tool, shown } = makeTool({ listed: alreadyListed });
    const confirm = vi.fn(() => Promise.resolve(false));
    await tool.autoDetectTrackedSegments(confirm);
    expect(confirm).toHaveBeenCalledWith({
      detectedCount: 2,
      trackedAfter: MAX_TRACKED_SEGMENTS + 1,
    });
    expect(shown).toEqual([]);

    confirm.mockResolvedValueOnce(true);
    await tool.autoDetectTrackedSegments(confirm);
    expect(shown).toEqual([100n, 200n]);
  });

  it("ignores a second auto-detect while the first awaits its answer", async () => {
    const alreadyListed = Array.from(
      { length: MAX_TRACKED_SEGMENTS - 1 },
      (_, i) => BigInt(1000 + i),
    );
    const { tool, shown } = makeTool({ listed: alreadyListed });
    let answer: (proceed: boolean) => void = () => {};
    const confirm = vi.fn(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const first = tool.autoDetectTrackedSegments(confirm);
    const second = tool.autoDetectTrackedSegments(confirm);
    await second;
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    answer(true);
    await first;
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([100n, 200n]);
  });

  it("does not ask when auto-detect stays within the limit", async () => {
    const { tool } = makeTool({ listed: [] });
    const confirm = vi.fn(() => Promise.resolve(false));
    await tool.autoDetectTrackedSegments(confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(tool.trackedSegments()).toEqual([100n, 200n]);
  });
});

describe("ZExtrapolationTool run gating (TM-518)", () => {
  it("asks to pick segments when none are listed", () => {
    const { tool } = makeTool({ listed: [] });
    expect(tool.runDisabledReason()).toBe(
      "Double-click segments in the viewer (or Auto-detect) to track them.",
    );
  });

  it("asks to tick a segment when all are untracked", () => {
    const { tool } = makeTool();
    tool.setAllSegmentsTracked(false);
    expect(tool.runDisabledReason()).toBe(
      "All segments are untracked — tick at least one to run.",
    );
  });

  it("blocks more tracked segments than one run can carry", () => {
    const tooMany = Array.from({ length: MAX_TRACKED_SEGMENTS + 2 }, (_, i) =>
      BigInt(i + 1),
    );
    const { tool } = makeTool({ listed: tooMany });
    expect(tool.runDisabledReason()).toBe(
      `Tracking ${MAX_TRACKED_SEGMENTS + 2} segments — untrack 2 more ` +
        `(at most ${MAX_TRACKED_SEGMENTS} per run).`,
    );
    tool.setSegmentTracked(1n, false);
    tool.setSegmentTracked(2n, false);
    expect(tool.runDisabledReason()).toBeUndefined();
  });
});

describe("ZExtrapolationTool merged segments (TM-518)", () => {
  it("marks a merged segment and blocks running while it is tracked", () => {
    const { tool } = makeTool({ merged: [200n] });
    expect(tool.segmentRows()[1].isMerged).toBe(true);
    expect(tool.runDisabledReason()).toBe(
      "Segment 200 is merged with other segments — z-extrapolation tracks " +
        "unmerged segments only. Untrack it to run.",
    );
    tool.setSegmentTracked(200n, false);
    expect(tool.runDisabledReason()).toBeUndefined();
  });
});

describe("ZExtrapolationTool run (TM-518)", () => {
  it("propagates only the tracked segments", async () => {
    const { tool, sentMasks, writes } = makeTool();
    tool.setSegmentTracked(200n, false);
    await tool.runNextSlice();
    // Current mask [100,100,200,0]: only 100 is labelled.
    expect([...sentMasks[0]]).toEqual([1, 1, 0, 0]);
    expect(writes).toHaveLength(1);
    expect(writes[0].box.origin).toEqual([0, 0, 6]);
    expect([...(writes[0].dense as BigUint64Array)]).toEqual([
      100n,
      100n,
      100n,
      100n,
    ]);
  });

  it("keeps an untracked segment's voxels on the next slice", async () => {
    const { tool, writes } = makeTool();
    tool.setSegmentTracked(200n, false);
    await tool.runNextSlice();
    // The prediction covers every voxel with 100, but the next slice holds 200
    // in its last two voxels: those stay unwritten.
    expect([...(writes[0].valueMask ?? [])]).toEqual([1, 1, 0, 0]);
  });

  it("writes over nothing it should keep when every segment is tracked", async () => {
    const { tool, writes } = makeTool();
    await tool.runNextSlice();
    expect([...(writes[0].valueMask ?? [])]).toEqual([1, 1, 1, 1]);
  });

  it("prefetches the slice the following run needs", async () => {
    const { tool, readZs } = makeTool();
    await tool.runNextSlice(); // 5 → 6
    await settle();
    expect(readZs.sort((a, b) => a - b)).toEqual([5, 6, 7]);
    await tool.runNextSlice(); // 6 → 7: both slices already held
    await settle();
    expect(readZs.sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
  });

  it("does not prefetch past the session region", async () => {
    const { tool, readZs, writes, goToSlice } = makeTool();
    goToSlice(BOUNDS.hiZ - 2); // run writes the last slice
    await tool.runNextSlice();
    await settle();
    expect(writes).toHaveLength(1);
    expect(readZs.sort((a, b) => a - b)).toEqual([
      BOUNDS.hiZ - 2,
      BOUNDS.hiZ - 1,
    ]);
  });

  it("prefetches the current and next slice once the Z settles", async () => {
    vi.useFakeTimers();
    const { readZs, goToSlice } = makeTool();
    goToSlice(10);
    goToSlice(12); // a quick second change replaces the first
    await vi.advanceTimersByTimeAsync(300);
    expect(readZs.sort((a, b) => a - b)).toEqual([12, 13]);
  });

  it("prefetches nothing once disposed", async () => {
    vi.useFakeTimers();
    const { tool, readZs, goToSlice } = makeTool();
    goToSlice(10);
    tool.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(readZs).toEqual([]);
  });
});

describe("ZExtrapolationTool current Z follows the viewport", () => {
  it("runs from the slice the user scrolled to after a run", async () => {
    const { tool, writes, scrollTo } = makeTool();
    await tool.runNextSlice(); // 5 → 6
    scrollTo(5.5);
    tool.followViewportZ();
    expect(tool.getState().currentZ).toBe(5);
    await tool.runNextSlice();
    expect(writes.map((write) => write.box.origin[2])).toEqual([6, 6]);
  });

  it("moves the viewport to a typed Current Z", () => {
    const { tool, viewportZ } = makeTool();
    tool.setCurrentZ(10);
    expect(viewportZ()).toBe(10.5);
    expect(tool.getState().currentZ).toBe(10);
  });

  it("follows the viewport after a typed Current Z", async () => {
    const { tool, writes, goToSlice } = makeTool();
    tool.setCurrentZ(10);
    goToSlice(5);
    expect(tool.getState().currentZ).toBe(5);
    await tool.runNextSlice();
    expect(writes.map((write) => write.box.origin[2])).toEqual([6]);
  });

  it("moves to the next slice after a run and back to it on Reset", async () => {
    const { tool, viewportZ } = makeTool();
    await tool.runNextSlice();
    expect(viewportZ()).toBe(6.5);
    expect(tool.getState().currentZ).toBe(6);
    await tool.resetLastRun();
    expect(viewportZ()).toBe(5.5);
    expect(tool.getState().currentZ).toBe(5);
    expect(tool.getState().hasLastRun).toBe(false);
  });
});

describe("ZExtrapolationTool empty steps (TM-518)", () => {
  function messages() {
    return vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockImplementation(() => ({}) as StatusMessage);
  }

  it("says the current slice is unpainted instead of running on it", async () => {
    const shown = messages();
    const { tool, sentMasks, writes, goToSlice } = makeTool({
      currentMask: BigUint64Array.from([0n, 0n, 0n, 0n]),
    });
    goToSlice(5); // a slice the user did not paint
    await tool.runNextSlice();
    expect(shown).toHaveBeenCalledWith(
      "None of the tracked segments is painted on Z=5. Paint them on this " +
        "slice, or set Current Z to the slice you painted.",
      8000,
    );
    expect(sentMasks).toEqual([]);
    expect(writes).toEqual([]);
    expect(tool.getState().currentZ).toBe(5);
    expect(tool.getState().hasLastRun).toBe(false);
  });

  it("does not count an untracked segment's voxels as something to run on", async () => {
    const shown = messages();
    const { tool, sentMasks } = makeTool({
      currentMask: BigUint64Array.from([200n, 200n, 0n, 0n]),
    });
    tool.setSegmentTracked(200n, false);
    await tool.runNextSlice();
    expect(sentMasks).toEqual([]);
    expect(shown.mock.calls[0][0]).toContain("painted on Z=5");
  });

  it("says when the model continued nothing onto the next slice", async () => {
    const shown = messages();
    const { tool } = makeTool({ predictedLabel: 0 });
    await tool.runNextSlice();
    expect(shown).toHaveBeenCalledWith(
      "The model found no continuation of the tracked segments on Z=6 — " +
        "nothing was painted there.",
      5000,
    );
    expect(tool.getState().currentZ).toBe(6);
  });

  it("stays quiet after a step that painted the next slice", async () => {
    const shown = messages();
    const { tool } = makeTool();
    await tool.runNextSlice();
    expect(shown).not.toHaveBeenCalled();
  });
});
