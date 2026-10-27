/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import { chunkGridKey } from "#src/editing/local_patch_source.js";
import type { PatchChunkChange } from "#src/editing/local_patch_store.js";
import { LocalPatchStore } from "#src/editing/local_patch_store.js";

const POSITION = [1, 2, 3];
const CHUNK_DATA_SIZE = [2, 2, 2];
const VOLUME = 8;

/**
 * The node test project has no `requestAnimationFrame`; queue the callbacks so
 * a test decides when the debounced `changed` flush runs.
 */
function installFrameQueue(): { runFrame: () => void } {
  let queued = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    queued.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    queued.delete(handle);
  });
  return {
    runFrame: () => {
      const callbacks = [...queued.values()];
      queued = new Map();
      for (const callback of callbacks) callback(0);
    },
  };
}

/** Record `chunkChanged` and `changed` dispatches in arrival order. */
function recordEvents(store: LocalPatchStore): {
  changes: PatchChunkChange[];
  order: string[];
} {
  const changes: PatchChunkChange[] = [];
  const order: string[] = [];
  store.chunkChanged.add((change) => {
    changes.push(change);
    order.push(`chunkChanged:${change.kind}`);
  });
  store.changed.add(() => {
    order.push("changed");
  });
  return { changes, order };
}

describe("LocalPatchStore.chunkChanged", () => {
  let store: LocalPatchStore;
  let frames: { runFrame: () => void };

  beforeEach(() => {
    frames = installFrameQueue();
    store = new LocalPatchStore();
  });

  afterEach(() => {
    store.dispose();
    vi.unstubAllGlobals();
  });

  it("reports a whole-chunk change for writeFullChunk", () => {
    const { changes } = recordEvents(store);
    store.writeFullChunk(POSITION, CHUNK_DATA_SIZE, new BigUint64Array(VOLUME));
    expect(changes).toEqual([
      { kind: "chunk", key: chunkGridKey(POSITION), box: null },
    ]);
  });

  it("forwards the mutated box from noteChunkMutated", () => {
    const { changes } = recordEvents(store);
    const box: ChunkVoxelBox = { x0: 0, y0: 1, z0: 0, x1: 1, y1: 1, z1: 0 };
    store.noteChunkMutated(POSITION, box);
    expect(changes).toEqual([
      { kind: "chunk", key: chunkGridKey(POSITION), box },
    ]);
  });

  it("reports a whole-chunk change when noteChunkMutated has no box", () => {
    const { changes } = recordEvents(store);
    store.noteChunkMutated(POSITION);
    expect(changes).toEqual([
      { kind: "chunk", key: chunkGridKey(POSITION), box: null },
    ]);
  });

  it("keeps recording the dirty key in noteChunkMutated", () => {
    store.noteChunkMutated(POSITION, {
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 0,
      y1: 0,
      z1: 0,
    });
    expect(store.source.dirtyKeys.has(chunkGridKey(POSITION))).toBe(true);
  });

  it("reports a whole-chunk change when clearing an existing chunk", () => {
    store.writeFullChunk(POSITION, CHUNK_DATA_SIZE, new BigUint64Array(VOLUME));
    const { changes } = recordEvents(store);
    store.clearChunk(POSITION);
    expect(changes).toEqual([
      { kind: "chunk", key: chunkGridKey(POSITION), box: null },
    ]);
  });

  it("stays silent when clearing a chunk that does not exist", () => {
    const { changes } = recordEvents(store);
    store.clearChunk(POSITION);
    expect(changes).toEqual([]);
  });

  it("reports all-cleared before the synchronous changed of clearAll", () => {
    store.writeFullChunk(POSITION, CHUNK_DATA_SIZE, new BigUint64Array(VOLUME));
    frames.runFrame();
    const { changes, order } = recordEvents(store);
    store.clearAll();
    expect(changes).toEqual([{ kind: "all-cleared" }]);
    expect(order).toEqual(["chunkChanged:all-cleared", "changed"]);
  });

  it("dispatches synchronously, ahead of the frame-debounced changed", () => {
    const { order } = recordEvents(store);
    store.writeFullChunk(POSITION, CHUNK_DATA_SIZE, new BigUint64Array(VOLUME));
    store.noteChunkMutated(POSITION);
    store.clearChunk(POSITION);
    expect(order).toEqual([
      "chunkChanged:chunk",
      "chunkChanged:chunk",
      "chunkChanged:chunk",
    ]);
    frames.runFrame();
    expect(order).toEqual([
      "chunkChanged:chunk",
      "chunkChanged:chunk",
      "chunkChanged:chunk",
      "changed",
    ]);
  });
});
