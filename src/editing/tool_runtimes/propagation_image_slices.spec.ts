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
  ReadonlyChunkVoxelBuffer,
  Resolution,
  ScaleMetadata,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdCodec,
  layerId,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";
import { PropagationImageSlices } from "#src/editing/tool_runtimes/propagation_image_slices.js";
import type { ImageReadSpec } from "#src/editing/tool_runtimes/slice_propagation.js";

const RES: Resolution = ResolutionCtor.from([8, 8, 8]);
const CHUNK_SIZE = 4;
const SCALE: ScaleMetadata = {
  resolution: RES,
  voxelSizeNm: [8, 8, 8],
  voxelOffset: [0, 0, 0],
  sizeVoxels: [64, 64, 64],
  chunkDataSize: [CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE],
};
const IMAGE: ImageReadSpec = {
  layerId: layerId("image"),
  resolution: RES,
  scale: SCALE,
  dataType: "uint8",
};
/** One chunk in XY, so each Z costs exactly one chunk read per chunk-Z. */
const AREA = { originX: 0, originY: 0, width: 2, height: 2 };

/** Chunk reader whose voxels hold their global Z; counts reads per chunk Z. */
function countingReader() {
  const readsByChunkZ = new Map<number, number>();
  let failNext = false;
  const reader: ReadChunkAt = (
    _layer: LayerId,
    _resolution: Resolution,
    chunkId: ChunkId,
  ) => {
    const { z: chunkZ } = ChunkIdCodec.toCoord(chunkId);
    readsByChunkZ.set(chunkZ, (readsByChunkZ.get(chunkZ) ?? 0) + 1);
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("chunk read failed"));
    }
    const view = new Uint8Array(CHUNK_SIZE ** 3);
    for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
      view.fill(
        chunkZ * CHUNK_SIZE + localZ,
        localZ * CHUNK_SIZE * CHUNK_SIZE,
        (localZ + 1) * CHUNK_SIZE * CHUNK_SIZE,
      );
    }
    const buffer: ReadonlyChunkVoxelBuffer = {
      byteLength: view.byteLength,
      asView: () => view,
    };
    return Promise.resolve(buffer);
  };
  const totalReads = () =>
    [...readsByChunkZ.values()].reduce((sum, count) => sum + count, 0);
  return {
    reader,
    totalReads,
    failNextRead: () => {
      failNext = true;
    },
  };
}

describe("PropagationImageSlices", () => {
  it("returns uint8 slices in the requested order", async () => {
    const { reader } = countingReader();
    const slices = new PropagationImageSlices(reader);
    const [first, second] = await slices.read(IMAGE, AREA, [6, 5]);
    expect([...first]).toEqual([6, 6, 6, 6]);
    expect([...second]).toEqual([5, 5, 5, 5]);
  });

  it("reads a chunk shared by current and next Z once", async () => {
    const { reader, totalReads } = countingReader();
    await new PropagationImageSlices(reader).read(IMAGE, AREA, [5, 6]);
    expect(totalReads()).toBe(1);
  });

  it("serves the previous run's next slice without reading again", async () => {
    const { reader, totalReads } = countingReader();
    const slices = new PropagationImageSlices(reader);
    await slices.read(IMAGE, AREA, [5, 6]); // chunk z=1
    await slices.read(IMAGE, AREA, [6, 7]); // 6 held; 7 in chunk z=1 again
    expect(totalReads()).toBe(2);
    await slices.read(IMAGE, AREA, [6, 7]); // both held
    expect(totalReads()).toBe(2);
  });

  it("lets a run reuse a prefetched slice", async () => {
    const { reader, totalReads } = countingReader();
    const slices = new PropagationImageSlices(reader);
    slices.prefetch(IMAGE, AREA, 9);
    const [slice] = await slices.read(IMAGE, AREA, [9]);
    expect([...slice]).toEqual([9, 9, 9, 9]);
    expect(totalReads()).toBe(1);
  });

  it("keys slices by area, so another area is read fresh", async () => {
    const { reader, totalReads } = countingReader();
    const slices = new PropagationImageSlices(reader);
    await slices.read(IMAGE, AREA, [5]);
    await slices.read(IMAGE, { ...AREA, originX: 1 }, [5]);
    expect(totalReads()).toBe(2);
  });

  it("evicts the least recently used slice past capacity", async () => {
    const { reader, totalReads } = countingReader();
    const slices = new PropagationImageSlices(reader, 2);
    await slices.read(IMAGE, AREA, [1]);
    await slices.read(IMAGE, AREA, [2]);
    await slices.read(IMAGE, AREA, [1]); // 1 is now the most recent
    await slices.read(IMAGE, AREA, [3]); // evicts 2
    expect(totalReads()).toBe(3);
    await slices.read(IMAGE, AREA, [1]);
    expect(totalReads()).toBe(3);
    await slices.read(IMAGE, AREA, [2]);
    expect(totalReads()).toBe(4);
  });

  it("does not evict a held slice that the same read returns", async () => {
    const { reader } = countingReader();
    const slices = new PropagationImageSlices(reader, 2);
    await slices.read(IMAGE, AREA, [1]);
    await slices.read(IMAGE, AREA, [2]);
    // 1 is the oldest; adding 9 must not drop it before it is returned.
    const [held, added] = await slices.read(IMAGE, AREA, [1, 9]);
    expect([...held]).toEqual([1, 1, 1, 1]);
    expect([...added]).toEqual([9, 9, 9, 9]);
  });

  it("drops a failed read so the next read retries", async () => {
    const { reader, totalReads, failNextRead } = countingReader();
    const slices = new PropagationImageSlices(reader);
    failNextRead();
    await expect(slices.read(IMAGE, AREA, [5])).rejects.toThrow(
      "chunk read failed",
    );
    const [slice] = await slices.read(IMAGE, AREA, [5]);
    expect([...slice]).toEqual([5, 5, 5, 5]);
    expect(totalReads()).toBe(2);
  });

  it("swallows a failed prefetch and reads the slice again on demand", async () => {
    const { reader, totalReads, failNextRead } = countingReader();
    const slices = new PropagationImageSlices(reader);
    failNextRead();
    slices.prefetch(IMAGE, AREA, 5);
    // Let the failed prefetch settle: no unhandled rejection, entry dropped.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [slice] = await slices.read(IMAGE, AREA, [5]);
    expect([...slice]).toEqual([5, 5, 5, 5]);
    expect(totalReads()).toBe(2);
  });
});
