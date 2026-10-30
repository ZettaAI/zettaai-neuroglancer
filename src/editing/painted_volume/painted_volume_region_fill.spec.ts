/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ChunkId } from "@zettaai/edit-session";
import { ChunkId as ChunkIdFactory } from "@zettaai/edit-session";
import { describe, expect, it, vi } from "vitest";

import type { BaselineVoxelView } from "#src/editing/painted_volume/painted_volume_occupancy.js";
import {
  PaintedVolumeRegionFill,
  chunkIdOfKey,
  chunkKeyOf,
} from "#src/editing/painted_volume/painted_volume_region_fill.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";

interface PendingRead {
  readonly chunkId: ChunkId;
  readonly signal: AbortSignal;
  resolve(view: BaselineVoxelView): void;
  reject(error: unknown): void;
}

function chunkIdOf(x: number): ChunkId {
  return ChunkIdFactory.fromCoord({ x, y: 0, z: 0 });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeFill(maxReadsInFlight = 2) {
  const reads: PendingRead[] = [];
  const read = (chunkId: ChunkId, signal: AbortSignal) =>
    new Promise<BaselineVoxelView>((resolve, reject) => {
      reads.push({ chunkId, signal, resolve, reject });
    });
  const logger = new FakeLogger();
  const onReady = vi.fn();
  const fill = new PaintedVolumeRegionFill(
    read,
    onReady,
    logger,
    maxReadsInFlight,
  );
  return { fill, reads, logger, onReady };
}

describe("chunk keys", () => {
  it("round-trip between the store's grid key and the library chunk id", () => {
    const chunkId = ChunkIdFactory.fromCoord({ x: 3, y: -1, z: 7 });
    expect(chunkKeyOf(chunkId)).toBe("3,-1,7");
    expect(chunkIdOfKey("3,-1,7")).toBe(chunkId);
  });
});

describe("PaintedVolumeRegionFill", () => {
  it("keeps at most the allowed number of reads in flight", () => {
    const { fill, reads } = makeFill(2);
    fill.start([0, 1, 2, 3].map(chunkIdOf));
    expect(reads.map((read) => read.chunkId)).toEqual([
      chunkIdOf(0),
      chunkIdOf(1),
    ]);
    expect(fill.progress.value).toEqual({ done: 0, total: 4, failed: 0 });
    expect(fill.active).toBe(true);
  });

  it("hands out landed chunks and reads on as they are taken", async () => {
    const { fill, reads, onReady } = makeFill(2);
    fill.start([0, 1, 2].map(chunkIdOf));
    const view = new Uint32Array(1);
    expect(fill.hasLanded).toBe(false);
    reads[1].resolve(view);
    await settle();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(fill.hasLanded).toBe(true);

    expect(fill.takeReady()).toEqual({
      chunkId: chunkIdOf(1),
      key: "1,0,0",
      baseline: view,
    });
    expect(fill.takeReady()).toBeUndefined();
    expect(reads).toHaveLength(3);
    expect(fill.progress.value).toEqual({ done: 1, total: 3, failed: 0 });
  });

  it("does not read ahead past chunks nobody has taken", async () => {
    const { fill, reads } = makeFill(2);
    fill.start([0, 1, 2].map(chunkIdOf));
    reads[0].resolve(new Uint32Array(1));
    reads[1].resolve(new Uint32Array(1));
    await settle();
    expect(reads).toHaveLength(2);
  });

  it("counts a failed read, logs it and carries on", async () => {
    const { fill, reads, logger } = makeFill(1);
    fill.start([0, 1].map(chunkIdOf));
    reads[0].reject(new Error("unreachable"));
    await settle();
    expect(fill.progress.value).toEqual({ done: 1, total: 2, failed: 1 });
    expect(logger.logs.filter((log) => log.level === "warn")).toHaveLength(1);
    expect(reads).toHaveLength(2);
  });

  it("finishes when every chunk was taken or failed", async () => {
    const { fill, reads } = makeFill(2);
    fill.start([0, 1].map(chunkIdOf));
    reads[0].resolve(new Uint32Array(1));
    reads[1].reject(new Error("gone"));
    await settle();
    expect(fill.active).toBe(true);
    fill.takeReady();
    expect(fill.active).toBe(false);
    expect(fill.progress.value).toEqual({ done: 2, total: 2, failed: 1 });
  });

  it("a new pass aborts the previous one and drops its results", async () => {
    const { fill, reads, logger } = makeFill(2);
    fill.start([0, 1].map(chunkIdOf));
    const firstPass = [...reads];
    fill.start([5].map(chunkIdOf));
    expect(firstPass.every((read) => read.signal.aborted)).toBe(true);
    firstPass[0].resolve(new Uint32Array(1));
    firstPass[1].reject(new Error("aborted"));
    await settle();

    expect(fill.takeReady()).toBeUndefined();
    expect(logger.logs).toHaveLength(0);
    expect(fill.progress.value).toEqual({ done: 0, total: 1, failed: 0 });
    expect(reads[2].chunkId).toBe(chunkIdOf(5));
  });

  it("cancel aborts reads and goes idle", () => {
    const { fill, reads } = makeFill(2);
    fill.start([0, 1].map(chunkIdOf));
    fill.cancel();
    expect(reads.every((read) => read.signal.aborted)).toBe(true);
    expect(fill.active).toBe(false);
  });
});
