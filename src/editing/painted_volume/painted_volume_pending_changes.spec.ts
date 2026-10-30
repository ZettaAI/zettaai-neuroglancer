/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import {
  PaintedVolumePendingChanges,
  isWholeChunkBox,
  wholeChunkBox,
} from "#src/editing/painted_volume/painted_volume_pending_changes.js";

type Triple = readonly [number, number, number];

const CHUNK_SIZE: Triple = [4, 4, 2];
const CHUNK_VOLUME = 32;

function boxOf(lo: Triple, hi: Triple): ChunkVoxelBox {
  return { x0: lo[0], y0: lo[1], z0: lo[2], x1: hi[0], y1: hi[1], z1: hi[2] };
}

describe("wholeChunkBox / isWholeChunkBox", () => {
  it("spans every voxel of the chunk, inclusive", () => {
    expect(wholeChunkBox(CHUNK_SIZE)).toEqual(boxOf([0, 0, 0], [3, 3, 1]));
    expect(isWholeChunkBox(wholeChunkBox(CHUNK_SIZE), CHUNK_SIZE)).toBe(true);
    expect(isWholeChunkBox(boxOf([0, 0, 0], [3, 3, 0]), CHUNK_SIZE)).toBe(
      false,
    );
  });
});

describe("PaintedVolumePendingChanges", () => {
  it("unions boxes noted for the same chunk", () => {
    const pending = new PaintedVolumePendingChanges();
    pending.note("0,0,0", boxOf([1, 1, 0], [1, 1, 0]));
    pending.note("0,0,0", boxOf([2, 0, 1], [3, 1, 1]));

    expect(pending.drain(Infinity, CHUNK_SIZE)).toEqual([
      { key: "0,0,0", box: boxOf([1, 0, 0], [3, 1, 1]) },
    ]);
    expect(pending.size).toBe(0);
  });

  it("lets a whole-chunk change absorb any box, before or after it", () => {
    const pending = new PaintedVolumePendingChanges();
    pending.note("a", boxOf([1, 1, 0], [1, 1, 0]));
    pending.note("a", null);
    pending.note("b", null);
    pending.note("b", boxOf([1, 1, 0], [1, 1, 0]));

    const drained = pending.drain(Infinity, CHUNK_SIZE);
    expect(drained).toEqual([
      { key: "a", box: wholeChunkBox(CHUNK_SIZE) },
      { key: "b", box: wholeChunkBox(CHUNK_SIZE) },
    ]);
  });

  it("does not alias the caller's box", () => {
    const pending = new PaintedVolumePendingChanges();
    const box = boxOf([0, 0, 0], [0, 0, 0]);
    pending.note("a", box);
    pending.note("a", boxOf([2, 2, 1], [2, 2, 1]));
    expect(box).toEqual(boxOf([0, 0, 0], [0, 0, 0]));
  });

  it("drains in arrival order until the voxel budget is spent", () => {
    const pending = new PaintedVolumePendingChanges();
    pending.note("a", null);
    pending.note("b", null);
    pending.note("c", boxOf([0, 0, 0], [0, 0, 0]));

    const first = pending.drain(CHUNK_VOLUME + 1, CHUNK_SIZE);
    expect(first.map((change) => change.key)).toEqual(["a", "b"]);
    expect(pending.size).toBe(1);
    expect(pending.drain(CHUNK_VOLUME, CHUNK_SIZE)).toEqual([
      { key: "c", box: boxOf([0, 0, 0], [0, 0, 0]) },
    ]);
  });

  it("always drains at least one change, even over budget", () => {
    const pending = new PaintedVolumePendingChanges();
    pending.note("a", null);
    expect(pending.drain(1, CHUNK_SIZE)).toHaveLength(1);
  });

  it("forgets a chunk on delete and everything on clear", () => {
    const pending = new PaintedVolumePendingChanges();
    pending.note("a", null);
    pending.note("b", null);
    pending.delete("a");
    expect(pending.drain(Infinity, CHUNK_SIZE).map((c) => c.key)).toEqual([
      "b",
    ]);
    pending.note("c", null);
    pending.clear();
    expect(pending.size).toBe(0);
  });
});
