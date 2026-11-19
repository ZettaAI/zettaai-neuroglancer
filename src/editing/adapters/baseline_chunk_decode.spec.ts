/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeCompressedBaseline,
  padToEditSize,
  type CompressedBaselineChunk,
} from "#src/editing/adapters/baseline_chunk_decode.js";
import type {
  BaselineDecodeRequest,
  BaselineDecodeResult,
} from "#src/editing/adapters/baseline_decode_protocol.js";
import { encodeChannels as encodeChannelsUint32 } from "#src/sliceview/compressed_segmentation/encode_uint32.js";
import { encodeChannels as encodeChannelsUint64 } from "#src/sliceview/compressed_segmentation/encode_uint64.js";
import { TypedArrayBuilder } from "#src/util/array.js";

type Size = readonly [number, number, number];

const BLOCK: Size = [8, 8, 1];

/** Deterministic pseudo-random ids from a small alphabet. */
function randomIds(size: Size, seed: number): number[] {
  let state = seed;
  const ids: number[] = [];
  for (let i = 0; i < size[0] * size[1] * size[2]; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    ids.push((state >>> 8) % 37);
  }
  return ids;
}

function uint64Values(ids: number[]): BigUint64Array {
  // High word set too, so a dropped high word shows.
  return BigUint64Array.from(ids, (id) => BigInt(id) * 0x100000001n);
}

function compressedUint64(
  ids: number[],
  clipped: Size,
  edit: Size,
): CompressedBaselineChunk {
  const output = new TypedArrayBuilder(Uint32Array);
  encodeChannelsUint64(output, BLOCK, uint64Values(ids), [...clipped, 1]);
  return {
    compressed: output.view.slice(),
    dataType: "uint64",
    blockSize: BLOCK,
    clippedSize: clipped,
    editSize: edit,
  };
}

function compressedUint32(
  ids: number[],
  clipped: Size,
  edit: Size,
): CompressedBaselineChunk {
  const output = new TypedArrayBuilder(Uint32Array);
  encodeChannelsUint32(output, BLOCK, Uint32Array.from(ids), [...clipped, 1]);
  return {
    compressed: output.view.slice(),
    dataType: "uint32",
    blockSize: BLOCK,
    clippedSize: clipped,
    editSize: edit,
  };
}

/** `values` at `clipped` placed in the low corner of a zero buffer of `edit`. */
function padded<T extends Uint32Array | BigUint64Array>(
  values: T,
  clipped: Size,
  edit: Size,
): T {
  const out = new (values.constructor as new (length: number) => T)(
    edit[0] * edit[1] * edit[2],
  );
  for (let z = 0; z < clipped[2]; z++) {
    for (let y = 0; y < clipped[1]; y++) {
      for (let x = 0; x < clipped[0]; x++) {
        out[(z * edit[1] + y) * edit[0] + x] =
          values[(z * clipped[1] + y) * clipped[0] + x];
      }
    }
  }
  return out;
}

describe("decodeCompressedBaseline", () => {
  it("decodes an interior uint64 chunk to its values", () => {
    const size: Size = [24, 16, 2];
    const ids = randomIds(size, 1);
    const decoded = decodeCompressedBaseline(compressedUint64(ids, size, size));
    expect(decoded).toEqual(uint64Values(ids));
  });

  it("pads an edge uint64 chunk to the edit size, zero outside the data", () => {
    const clipped: Size = [13, 9, 1];
    const edit: Size = [24, 16, 1];
    const ids = randomIds(clipped, 2);
    const decoded = decodeCompressedBaseline(
      compressedUint64(ids, clipped, edit),
    );
    expect(decoded).toEqual(padded(uint64Values(ids), clipped, edit));
  });

  it("pads an edge uint32 chunk the same way", () => {
    const clipped: Size = [5, 7, 3];
    const edit: Size = [8, 8, 4];
    const ids = randomIds(clipped, 3);
    const decoded = decodeCompressedBaseline(
      compressedUint32(ids, clipped, edit),
    );
    expect(decoded).toEqual(padded(Uint32Array.from(ids), clipped, edit));
  });
});

describe("padToEditSize", () => {
  it("returns the buffer itself when it already fills the edit size", () => {
    const values = new Uint8Array([1, 2, 3, 4]);
    expect(padToEditSize(values, [2, 2, 1], [2, 2, 1])).toBe(values);
  });

  it("keeps the element type", () => {
    const values = new Int16Array([-1, 2]);
    const result = padToEditSize(values, [2, 1, 1], [3, 1, 1]);
    expect(result).toBeInstanceOf(Int16Array);
    expect(Array.from(result)).toEqual([-1, 2, 0]);
  });
});

/**
 * A stand-in for the decode worker: answers like
 * `baseline_decode_worker_handler.ts`, asynchronously, and records the
 * transfer lists it was given.
 */
class FakeDecodeWorker {
  static instances: FakeDecodeWorker[] = [];
  static failToLoad = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly transfers: Transferable[][] = [];
  readonly handled: number[] = [];

  constructor() {
    FakeDecodeWorker.instances.push(this);
    setTimeout(() => {
      if (FakeDecodeWorker.failToLoad) {
        this.onerror?.({ message: "" } as ErrorEvent);
      } else {
        this.onmessage?.({ data: null } as MessageEvent);
      }
    }, 0);
  }

  postMessage(request: BaselineDecodeRequest, transfer: Transferable[]): void {
    this.transfers.push(transfer);
    setTimeout(() => {
      this.handled.push(request.id);
      let result: BaselineDecodeResult;
      try {
        result = {
          id: request.id,
          decoded: decodeCompressedBaseline(request.chunk),
        };
      } catch (error) {
        result = { id: request.id, error: String(error) };
      }
      this.onmessage?.({ data: result } as MessageEvent);
    }, 0);
  }
}

async function freshPool() {
  vi.resetModules();
  return import("#src/editing/adapters/baseline_decode_pool.js");
}

describe("decodeBaselineOffMainThread", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeDecodeWorker.instances = [];
    FakeDecodeWorker.failToLoad = false;
  });

  it("decodes on the main thread when there is no Worker", async () => {
    vi.stubGlobal("Worker", undefined);
    const { decodeBaselineOffMainThread } = await freshPool();
    const size: Size = [16, 8, 1];
    const ids = randomIds(size, 4);
    await expect(
      decodeBaselineOffMainThread(compressedUint64(ids, size, size)),
    ).resolves.toEqual(uint64Values(ids));
  });

  it("decodes on a worker, transferring the compressed block in", async () => {
    vi.stubGlobal("Worker", FakeDecodeWorker);
    const { decodeBaselineOffMainThread } = await freshPool();
    const clipped: Size = [9, 8, 1];
    const edit: Size = [16, 8, 1];
    const ids = randomIds(clipped, 5);
    const chunk = compressedUint64(ids, clipped, edit);
    const compressedBuffer = chunk.compressed.buffer;

    const decoded = await decodeBaselineOffMainThread(chunk);
    expect(decoded).toEqual(padded(uint64Values(ids), clipped, edit));
    expect(FakeDecodeWorker.instances).toHaveLength(1);
    expect(FakeDecodeWorker.instances[0]!.transfers).toEqual([
      [compressedBuffer],
    ]);
  });

  it("runs at most two workers and queues the rest", async () => {
    vi.stubGlobal("Worker", FakeDecodeWorker);
    const { decodeBaselineOffMainThread } = await freshPool();
    const size: Size = [8, 8, 1];
    const jobs = [6, 7, 8, 9, 10].map((seed) => randomIds(size, seed));
    const results = await Promise.all(
      jobs.map((ids) =>
        decodeBaselineOffMainThread(compressedUint32(ids, size, size)),
      ),
    );
    expect(results).toEqual(jobs.map((ids) => Uint32Array.from(ids)));
    expect(FakeDecodeWorker.instances).toHaveLength(2);
    const handled = FakeDecodeWorker.instances.flatMap((w) => w.handled);
    expect(handled.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("rejects when the worker cannot decode the block", async () => {
    vi.stubGlobal("Worker", FakeDecodeWorker);
    const { decodeBaselineOffMainThread } = await freshPool();
    const broken: CompressedBaselineChunk = {
      compressed: new Uint32Array(1),
      dataType: "uint64",
      blockSize: BLOCK,
      clippedSize: [8, 8, 1],
      editSize: [8, 8, 1],
    };
    await expect(decodeBaselineOffMainThread(broken)).rejects.toThrow();
  });

  it("falls back to the main thread when the worker fails to load", async () => {
    vi.stubGlobal("Worker", FakeDecodeWorker);
    FakeDecodeWorker.failToLoad = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decodeBaselineOffMainThread } = await freshPool();
    const size: Size = [8, 8, 1];
    const first = randomIds(size, 11);
    const second = randomIds(size, 12);

    await expect(
      decodeBaselineOffMainThread(compressedUint32(first, size, size)),
    ).resolves.toEqual(Uint32Array.from(first));
    // Later decodes skip the workers entirely.
    await expect(
      decodeBaselineOffMainThread(compressedUint32(second, size, size)),
    ).resolves.toEqual(Uint32Array.from(second));
    expect(FakeDecodeWorker.instances).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
