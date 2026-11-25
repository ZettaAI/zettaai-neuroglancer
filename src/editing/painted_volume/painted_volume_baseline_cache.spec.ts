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

import { PaintedVolumeBaselineCache } from "#src/editing/painted_volume/painted_volume_baseline_cache.js";
import type { BaselineVoxelView } from "#src/editing/painted_volume/painted_volume_occupancy.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";

interface PendingRead {
  readonly chunkId: ChunkId;
  readonly signal: AbortSignal;
  resolve(view: BaselineVoxelView): void;
  reject(error: unknown): void;
}

/** Reader whose reads settle only when the test says so. */
function makeManualReader() {
  const reads: PendingRead[] = [];
  const read = (chunkId: ChunkId, signal: AbortSignal) =>
    new Promise<BaselineVoxelView>((resolve, reject) => {
      reads.push({ chunkId, signal, resolve, reject });
    });
  return { reads, read };
}

function chunkIdOf(x: number): ChunkId {
  return ChunkIdFactory.fromCoord({ x, y: 0, z: 0 });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeCache(limits = { maxChunks: 16, maxBytes: 1 << 30 }) {
  const reader = makeManualReader();
  const logger = new FakeLogger();
  const onLoaded = vi.fn();
  const cache = new PaintedVolumeBaselineCache(
    reader.read,
    onLoaded,
    logger,
    limits,
  );
  return { cache, reader, logger, onLoaded };
}

describe("PaintedVolumeBaselineCache", () => {
  it("starts one read per missing chunk and reports it loading", () => {
    const { cache, reader } = makeCache();
    expect(cache.lookup("0,0,0", chunkIdOf(0))).toEqual({ kind: "loading" });
    expect(cache.lookup("0,0,0", chunkIdOf(0))).toEqual({ kind: "loading" });
    expect(reader.reads).toHaveLength(1);
    expect(reader.reads[0].chunkId).toBe(chunkIdOf(0));
  });

  it("serves the decoded view once the read lands and wakes the owner", async () => {
    const { cache, reader, onLoaded } = makeCache();
    cache.lookup("0,0,0", chunkIdOf(0));
    const view = new Uint32Array([1, 2]);
    reader.reads[0].resolve(view);
    await settle();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(cache.lookup("0,0,0", chunkIdOf(0))).toEqual({
      kind: "ready",
      view,
    });
    expect(reader.reads).toHaveLength(1);
  });

  it("evicts the least recently used chunk past the chunk limit", async () => {
    const { cache, reader } = makeCache({ maxChunks: 2, maxBytes: 1 << 30 });
    for (const x of [0, 1]) cache.lookup(`${x},0,0`, chunkIdOf(x));
    reader.reads[0].resolve(new Uint32Array(1));
    reader.reads[1].resolve(new Uint32Array(1));
    await settle();
    // Touch chunk 0 so chunk 1 becomes the oldest.
    expect(cache.lookup("0,0,0", chunkIdOf(0)).kind).toBe("ready");
    cache.lookup("2,0,0", chunkIdOf(2));
    reader.reads[2].resolve(new Uint32Array(1));
    await settle();

    expect(cache.lookup("0,0,0", chunkIdOf(0)).kind).toBe("ready");
    expect(cache.lookup("1,0,0", chunkIdOf(1)).kind).toBe("loading");
  });

  it("evicts past the byte limit", async () => {
    const { cache, reader } = makeCache({ maxChunks: 16, maxBytes: 12 });
    cache.lookup("0,0,0", chunkIdOf(0));
    cache.lookup("1,0,0", chunkIdOf(1));
    reader.reads[0].resolve(new Uint32Array(2));
    reader.reads[1].resolve(new Uint32Array(2));
    await settle();
    expect(cache.lookup("0,0,0", chunkIdOf(0)).kind).toBe("loading");
    expect(cache.lookup("1,0,0", chunkIdOf(1)).kind).toBe("ready");
  });

  it("reports a failed read once, logs it, and retries on the next lookup", async () => {
    const { cache, reader, logger, onLoaded } = makeCache();
    cache.lookup("0,0,0", chunkIdOf(0));
    reader.reads[0].reject(new Error("decode failed"));
    await settle();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(cache.lookup("0,0,0", chunkIdOf(0))).toEqual({ kind: "failed" });
    expect(logger.logs.some((log) => log.level === "warn")).toBe(true);
    expect(cache.lookup("0,0,0", chunkIdOf(0))).toEqual({ kind: "loading" });
    expect(reader.reads).toHaveLength(2);
  });

  it("evict drops the view and aborts a read in flight", async () => {
    const { cache, reader, onLoaded } = makeCache();
    cache.lookup("0,0,0", chunkIdOf(0));
    cache.evict("0,0,0");
    expect(reader.reads[0].signal.aborted).toBe(true);
    reader.reads[0].resolve(new Uint32Array(1));
    await settle();
    expect(onLoaded).not.toHaveBeenCalled();
    expect(cache.lookup("0,0,0", chunkIdOf(0))).toEqual({ kind: "loading" });
  });

  it("clear aborts every read and ignores late results, without logging aborts", async () => {
    const { cache, reader, logger, onLoaded } = makeCache();
    cache.lookup("0,0,0", chunkIdOf(0));
    cache.lookup("1,0,0", chunkIdOf(1));
    cache.clear();
    expect(reader.reads.every((read) => read.signal.aborted)).toBe(true);
    reader.reads[0].resolve(new Uint32Array(1));
    reader.reads[1].reject(new Error("aborted"));
    await settle();
    expect(onLoaded).not.toHaveBeenCalled();
    expect(logger.logs).toHaveLength(0);
  });
});
