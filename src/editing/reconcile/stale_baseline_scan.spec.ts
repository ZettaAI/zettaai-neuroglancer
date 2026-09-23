/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ReadonlyChunkVoxelBuffer } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import {
  classifyAgainstRetainedBaseline,
  scanForStaleBaselines,
  STALE_BASELINE_SCAN_CONCURRENCY,
} from "#src/editing/reconcile/stale_baseline_scan.js";
import type {
  ChunkOwnedGeometry,
  OwnedChunkWrite,
} from "#src/editing/region/owned_chunk_write.js";
import { ownedRegionHash } from "#src/editing/region/owned_chunk_write.js";

/** X-fastest, channel-slowest: index = z*(sizeX*sizeY) + y*sizeX + x. */
const CHUNK_SIZE: readonly [number, number, number] = [4, 3, 2];
const CHUNK_VOXELS = CHUNK_SIZE[0] * CHUNK_SIZE[1] * CHUNK_SIZE[2];

function voxelIndex(x: number, y: number, z: number): number {
  const [sizeX, sizeY] = CHUNK_SIZE;
  return z * sizeX * sizeY + y * sizeX + x;
}

function chunkBuffer(fill = 0): Uint8Array {
  return new Uint8Array(CHUNK_VOXELS).fill(fill);
}

function readonlyBuffer(bytes: Uint8Array): ReadonlyChunkVoxelBuffer {
  return { asView: () => bytes } as unknown as ReadonlyChunkVoxelBuffer;
}

/** Owns only x in [0,2) — the shape of a chunk shared with a neighbouring task. */
function halfOwnedGeometry(): ChunkOwnedGeometry {
  return {
    chunkDataSize: CHUNK_SIZE,
    bytesPerVoxel: 1,
    channels: 1,
    chunkBox: { start: [0, 0, 0], end: [4, 3, 2] },
    ownedBox: { start: [0, 0, 0], end: [2, 3, 2] },
    coversWholeChunk: false,
  };
}

function wholeChunkGeometry(): ChunkOwnedGeometry {
  return {
    ...halfOwnedGeometry(),
    ownedBox: { start: [0, 0, 0], end: [4, 3, 2] },
    coversWholeChunk: true,
  };
}

/** A planned write whose `owned.hash` really is the hash of `mine`. */
function ownedWrite(
  mine: Uint8Array,
  geometry: ChunkOwnedGeometry = halfOwnedGeometry(),
  chunkId = "0,0,0",
): OwnedChunkWrite {
  return {
    layerId: "layer-1",
    resolution: "8x8x40",
    chunkId,
    chunkCoord: { x: 0, y: 0, z: 0 },
    contentRef: { hash: "unused-whole-chunk-hash" },
    bytes: { asView: () => mine },
    owned: { ...geometry, hash: ownedRegionHash(mine, geometry) },
  } as unknown as OwnedChunkWrite;
}

describe("classifyAgainstRetainedBaseline", () => {
  it("reports unchanged when the remote still holds what we read", () => {
    const baseline = chunkBuffer(1);
    const mine = chunkBuffer(1);
    mine[voxelIndex(0, 0, 0)] = 9;

    expect(
      classifyAgainstRetainedBaseline(
        ownedWrite(mine),
        readonlyBuffer(baseline),
        readonlyBuffer(chunkBuffer(1)),
      ),
    ).toEqual({ kind: "unchanged" });
  });

  it("reports diverged, with both hashes, when the remote moved", () => {
    const baseline = chunkBuffer(1);
    const mine = chunkBuffer(1);
    mine[voxelIndex(0, 0, 0)] = 9;
    const remote = chunkBuffer(1);
    remote[voxelIndex(1, 0, 0)] = 7;

    const comparison = classifyAgainstRetainedBaseline(
      ownedWrite(mine),
      readonlyBuffer(remote),
      readonlyBuffer(baseline),
    );

    expect(comparison.kind).toBe("diverged");
    if (comparison.kind !== "diverged") return;
    expect(comparison.remoteHash).not.toBe(comparison.baselineHash);
  });

  /**
   * The reason detection is scoped to the owned sub-box. Task bboxes do not
   * land on the chunk grid, so a neighbour legitimately owns the other half of
   * this chunk; their save must not read as our conflict.
   */
  it("ignores a neighbour's write outside the owned sub-box", () => {
    const baseline = chunkBuffer(1);
    const mine = chunkBuffer(1);
    mine[voxelIndex(0, 0, 0)] = 9;

    const remote = chunkBuffer(1);
    remote[voxelIndex(3, 0, 0)] = 42; // x = 3 is the neighbour's half
    remote[voxelIndex(2, 1, 1)] = 43;

    expect(
      classifyAgainstRetainedBaseline(
        ownedWrite(mine),
        readonlyBuffer(remote),
        readonlyBuffer(baseline),
      ),
    ).toEqual({ kind: "unchanged" });
  });

  it("catches a neighbour's write that crosses into the owned sub-box", () => {
    const baseline = chunkBuffer(1);
    const mine = chunkBuffer(1);
    const remote = chunkBuffer(1);
    remote[voxelIndex(1, 0, 0)] = 42; // x = 1 is ours

    expect(
      classifyAgainstRetainedBaseline(
        ownedWrite(mine),
        readonlyBuffer(remote),
        readonlyBuffer(baseline),
      ).kind,
    ).toBe("diverged");
  });

  /**
   * Retrying a partially-applied save re-scans chunks that already landed. The
   * remote then holds OUR bytes and differs from the baseline — classifying
   * that as a conflict would raise one per already-written chunk on every
   * retry.
   */
  it("reports already-applied when the remote already holds our payload", () => {
    const baseline = chunkBuffer(1);
    const mine = chunkBuffer(1);
    mine[voxelIndex(0, 0, 0)] = 9;

    expect(
      classifyAgainstRetainedBaseline(
        ownedWrite(mine),
        readonlyBuffer(mine),
        readonlyBuffer(baseline),
      ),
    ).toEqual({ kind: "already-applied" });
  });

  it("treats a missing retained baseline as uncomparable, never as unchanged", () => {
    const mine = chunkBuffer(1);
    mine[voxelIndex(0, 0, 0)] = 9;

    expect(
      classifyAgainstRetainedBaseline(
        ownedWrite(mine),
        readonlyBuffer(chunkBuffer(1)),
        undefined,
      ),
    ).toEqual({ kind: "uncomparable", reason: "no-retained-baseline" });
  });

  it("treats an unreadable remote as uncomparable", () => {
    expect(
      classifyAgainstRetainedBaseline(
        ownedWrite(chunkBuffer(1)),
        undefined,
        readonlyBuffer(chunkBuffer(1)),
      ),
    ).toEqual({ kind: "uncomparable", reason: "remote-unreadable" });
  });

  it("compares whole-chunk writes over the whole chunk", () => {
    const baseline = chunkBuffer(1);
    const remote = chunkBuffer(1);
    remote[voxelIndex(3, 0, 0)] = 42; // outside the half-owned box, inside this one

    expect(
      classifyAgainstRetainedBaseline(
        ownedWrite(chunkBuffer(1), wholeChunkGeometry()),
        readonlyBuffer(remote),
        readonlyBuffer(baseline),
      ).kind,
    ).toBe("diverged");
  });
});

describe("scanForStaleBaselines", () => {
  const signal = () => new AbortController().signal;

  /**
   * A dirty chunk carrying a local edit, so its payload differs from an
   * untouched remote. Without the edit the write would be byte-identical to the
   * remote and classify as `already-applied`.
   */
  function writeWithLocalEdit(chunkId: string): OwnedChunkWrite {
    const mine = chunkBuffer(1);
    mine[voxelIndex(0, 0, 0)] = 9;
    return ownedWrite(mine, halfOwnedGeometry(), chunkId);
  }

  it("partitions chunks across every verdict", async () => {
    const unchanged = writeWithLocalEdit("a");
    const diverged = writeWithLocalEdit("b");
    const unreadable = writeWithLocalEdit("c");

    const movedRemote = chunkBuffer(1);
    movedRemote[voxelIndex(1, 0, 0)] = 7;

    const scan = await scanForStaleBaselines(
      [unchanged, diverged, unreadable],
      {
        readRemote: async (write) =>
          write.chunkId === "c"
            ? undefined
            : readonlyBuffer(
                write.chunkId === "b" ? movedRemote : chunkBuffer(1),
              ),
        readRetainedBaseline: async () => readonlyBuffer(chunkBuffer(1)),
      },
      signal(),
    );

    expect(scan.unchangedCount).toBe(1);
    expect(scan.diverged.map((entry) => entry.write.chunkId)).toEqual(["b"]);
    expect(scan.uncomparable).toEqual([
      { write: unreadable, reason: "remote-unreadable" },
    ]);
  });

  it("records a throwing read as uncomparable instead of failing the scan", async () => {
    const scan = await scanForStaleBaselines(
      [writeWithLocalEdit("a"), writeWithLocalEdit("b")],
      {
        readRemote: async (write) => {
          if (write.chunkId === "a") throw new Error("network down");
          return readonlyBuffer(chunkBuffer(1));
        },
        readRetainedBaseline: async () => readonlyBuffer(chunkBuffer(1)),
      },
      signal(),
    );

    expect(scan.uncomparable).toEqual([
      {
        write: expect.objectContaining({ chunkId: "a" }),
        reason: "remote-unreadable",
      },
    ]);
    expect(scan.unchangedCount).toBe(1);
  });

  it("never exceeds the concurrency budget", async () => {
    const writes = Array.from({ length: 20 }, (_unused, index) =>
      writeWithLocalEdit(String(index)),
    );
    let inFlight = 0;
    let peakInFlight = 0;

    await scanForStaleBaselines(
      writes,
      {
        readRemote: async () => {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await Promise.resolve();
          inFlight--;
          return readonlyBuffer(chunkBuffer(1));
        },
        readRetainedBaseline: async () => readonlyBuffer(chunkBuffer(1)),
      },
      signal(),
    );

    expect(peakInFlight).toBeLessThanOrEqual(STALE_BASELINE_SCAN_CONCURRENCY);
  });

  it("stops launching reads once aborted", async () => {
    const controller = new AbortController();
    let reads = 0;

    await scanForStaleBaselines(
      Array.from({ length: 20 }, (_unused, index) =>
        writeWithLocalEdit(String(index)),
      ),
      {
        readRemote: async () => {
          reads++;
          controller.abort();
          return readonlyBuffer(chunkBuffer(1));
        },
        readRetainedBaseline: async () => readonlyBuffer(chunkBuffer(1)),
      },
      controller.signal,
    );

    expect(reads).toBeLessThanOrEqual(STALE_BASELINE_SCAN_CONCURRENCY);
    expect(reads).toBeGreaterThan(0);
  });
});
