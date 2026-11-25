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
 * `PatchMirror` must hand the box `fuseOverlayIntoChunk` computed to the real
 * `LocalPatchStore`, so `chunkChanged` listeners (the 3D painted-volume
 * preview) can update only that box instead of the whole chunk.
 */

import type {
  EditSession,
  LayerId,
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdFactory,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NgLogger } from "#src/editing/adapters/ng_logger.js";
import { chunkGridKey } from "#src/editing/local_patch_source.js";
import type { PatchChunkChange } from "#src/editing/local_patch_store.js";
import { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { notePaintedSubBox } from "#src/editing/overlay/painted_subbox_registry.js";
import { PatchMirror } from "#src/editing/overlay/patch_mirror.js";

const LAYER = "label-scratch" as LayerId;
const RES = ResolutionCtor.from([16, 16, 45]);
const CHUNK_ID = ChunkIdFactory.fromCoord({ x: 0, y: 0, z: 0 });
const COORD: OverlayCoord = {
  layerId: LAYER,
  resolution: RES,
  chunkId: CHUNK_ID,
};
/** 4x4x1 chunk: large enough that a sub-box differs from the whole chunk. */
const CHUNK_DATA_SIZE = [4, 4, 1] as const;
const VOLUME = 16;

function buffer(bytes: Uint8Array): ReadonlyChunkVoxelBuffer {
  return {
    byteLength: bytes.byteLength,
    asView: () => bytes,
  } as unknown as ReadonlyChunkVoxelBuffer;
}

interface Harness {
  store: LocalPatchStore;
  changes: PatchChunkChange[];
  /** Paint `voxelIndices` and fire one commit hinted with `hint`. */
  commit: (
    voxelIndices: number[],
    hint: { x0: number; y0: number; x1: number; y1: number },
  ) => void;
  dispose: () => void;
}

function makeHarness(): Harness {
  const handlers: ((payload: { coord: OverlayCoord }) => void)[] = [];
  const overlay = new Uint8Array(VOLUME);
  const baseline = new Uint8Array(VOLUME);

  const session = {
    dirty: {
      on: (
        _event: string,
        callback: (payload: { coord: OverlayCoord }) => void,
      ) => {
        handlers.push(callback);
        return () => {
          const index = handlers.indexOf(callback);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
    },
    overlay: { read: async () => buffer(overlay.slice()) },
    baseline: {
      perLayer: new Map([
        [
          LAYER,
          {
            metadata: {
              scales: [{ resolution: RES, chunkDataSize: CHUNK_DATA_SIZE }],
            },
          },
        ],
      ]),
    },
  } as unknown as EditSession;

  const logger = {
    error: () => {},
    info: () => {},
    debug: () => {},
    warn: () => {},
  } as unknown as NgLogger;

  const store = new LocalPatchStore();
  const changes: PatchChunkChange[] = [];
  store.chunkChanged.add((change) => {
    changes.push(change);
  });

  const mirror = new PatchMirror(
    session,
    LAYER,
    store,
    logger,
    async () => buffer(baseline),
    async () => buffer(baseline),
  );

  return {
    store,
    changes,
    commit: (voxelIndices, hint) => {
      for (const index of voxelIndices) overlay[index] = 7;
      notePaintedSubBox(LAYER, RES, CHUNK_ID, { ...hint, z0: 0, z1: 0 });
      for (const handler of handlers) handler({ coord: COORD });
    },
    dispose: () => {
      mirror.dispose();
      store.dispose();
    },
  };
}

describe("PatchMirror → LocalPatchStore.chunkChanged", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    harness = makeHarness();
  });

  afterEach(() => {
    harness.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reports the fused change box, not the whole chunk", async () => {
    // Voxels (1,1) and (2,1): flat index x + 4*y.
    harness.commit([5, 6], { x0: 0, y0: 0, x1: 3, y1: 3 });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.changes).toEqual([
      {
        kind: "chunk",
        key: chunkGridKey([0, 0, 0]),
        box: { x0: 1, y0: 1, z0: 0, x1: 2, y1: 1, z1: 0 },
      },
    ]);
  });

  it("stays silent when a resync changes nothing", async () => {
    harness.commit([5], { x0: 1, y0: 1, x1: 1, y1: 1 });
    await vi.advanceTimersByTimeAsync(0);
    harness.changes.length = 0;

    harness.commit([], { x0: 1, y0: 1, x1: 1, y1: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.changes).toEqual([]);
  });
});
