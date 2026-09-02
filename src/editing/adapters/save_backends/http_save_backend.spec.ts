/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, LayerMetadata, SavedChunk } from "@zettaai/edit-session";
import { describe, expect, it, vi } from "vitest";

import {
  buildCutoutParams,
  dataSourceUrlToCutoutPath,
  HttpSaveBackend,
  parseResolution,
  SAVE_UPLOAD_CONCURRENCY,
} from "#src/editing/adapters/save_backends/http_save_backend.js";
import type { BackendClient } from "#src/editing/backend/backend_client.js";
import type { OwnedRegion } from "#src/editing/region/owned_chunk_write.js";
import { ownedRegionBytes } from "#src/editing/region/owned_chunk_write.js";
import { HttpError } from "#src/util/http_request.js";

describe("cutout request helpers", () => {
  it("maps precomputed / calcada / plain URLs to a storage path", () => {
    expect(dataSourceUrlToCutoutPath("gs://b/p|precomputed:")).toBe("gs://b/p");
    expect(dataSourceUrlToCutoutPath("calcada://gs://b/p")).toBe("gs://b/p");
    expect(dataSourceUrlToCutoutPath("gs://b/p/")).toBe("gs://b/p");
    expect(dataSourceUrlToCutoutPath("")).toBeUndefined();
    expect(dataSourceUrlToCutoutPath(undefined)).toBeUndefined();
  });

  it("parses a resolution key and rejects malformed ones", () => {
    expect(parseResolution("8x8x40")).toEqual([8, 8, 40]);
    expect(() => parseResolution("8x8")).toThrow();
    expect(() => parseResolution("axbxc")).toThrow();
  });

  it("builds repeated-key cutout params", () => {
    const params = buildCutoutParams({
      path: "gs://b/p",
      resolution: [8, 8, 40],
      start: [0, 0, 5],
      end: [64, 64, 6],
    });
    expect(params.get("path")).toBe("gs://b/p");
    expect(params.getAll("resolution")).toEqual(["8", "8", "40"]);
    expect(params.getAll("bbox_start")).toEqual(["0", "0", "5"]);
    expect(params.getAll("bbox_end")).toEqual(["64", "64", "6"]);
  });
});

const CHUNK_SIZE = [64, 64, 8] as const;

/** A whole-chunk owned region over a `size`-shaped single-channel uint8 chunk. */
function wholeChunkOwned(
  size: readonly [number, number, number],
  start: readonly [number, number, number],
): OwnedRegion {
  const end = start.map((lo, axis) => lo + size[axis]) as [
    number,
    number,
    number,
  ];
  return {
    chunkDataSize: size,
    bytesPerVoxel: 1,
    channels: 1,
    chunkBox: { start: [...start] as [number, number, number], end },
    ownedBox: { start: [...start] as [number, number, number], end },
    coversWholeChunk: true,
    hash: "whole-chunk-hash",
  };
}

function fakeChunk(coord: { x: number; y: number; z: number }): SavedChunk {
  const size = CHUNK_SIZE;
  const start = [coord.x * size[0], coord.y * size[1], coord.z * size[2]] as [
    number,
    number,
    number,
  ];
  return {
    layerId: "layer-1" as LayerId,
    resolution: "8x8x40",
    chunkId: `${coord.x},${coord.y},${coord.z}`,
    chunkCoord: coord,
    bytes: { asView: () => new Uint8Array([1, 2, 3, 4]) },
    owned: wholeChunkOwned(size, start),
  } as unknown as SavedChunk;
}

const metadata = { channels: 1 } as unknown as LayerMetadata;

function makeClient(request: BackendClient["request"]): BackendClient {
  return { request } as unknown as BackendClient;
}

describe("HttpSaveBackend.saveLayer", () => {
  it("posts each chunk to /painting/cutout with the derived bbox + gzipped body", async () => {
    const request = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response("", { status: 200 }),
    );
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p|precomputed:",
    });

    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 1, y: 0, z: 2 })],
      metadata,
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: "succeeded",
      layerId: "layer-1",
      chunkCount: 1,
    });
    const [path, init] = request.mock.calls[0];
    expect(path).toContain("/painting/cutout?");
    expect(path).toContain("path=gs%3A%2F%2Fb%2Fp");
    expect(path).toContain("bbox_start=64"); // 1 * 64 on x
    expect(path).toContain("bbox_end=128");
    expect((init as RequestInit).method).toBe("POST");
    // Body is gzip-compressed (magic bytes 0x1f 0x8b), not the raw chunk.
    const bodyBytes = new Uint8Array((init as RequestInit).body as ArrayBuffer);
    expect([bodyBytes[0], bodyBytes[1]]).toEqual([0x1f, 0x8b]);
  });

  it("skips a layer whose data-source URL cannot be resolved", async () => {
    const request = vi.fn();
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => undefined,
    });
    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 0, y: 0, z: 0 })],
      metadata,
      new AbortController().signal,
    );
    expect(result.status).toBe("skipped");
    expect(request).not.toHaveBeenCalled();
  });

  it("reports partial when some chunks fail", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockRejectedValueOnce(new Error("boom"));
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });
    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 0, y: 0, z: 0 }), fakeChunk({ x: 1, y: 0, z: 0 })],
      metadata,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "partial",
      succeeded: 1,
      failed: 1,
    });
  });

  it("returns succeeded with zero chunks without calling the client", async () => {
    const request = vi.fn();
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });
    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [],
      metadata,
      new AbortController().signal,
    );
    expect(result).toEqual({
      status: "succeeded",
      layerId: "layer-1",
      chunkCount: 0,
    });
    expect(request).not.toHaveBeenCalled();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkIndexFromPath(path: string): number {
  const query = path.slice(path.indexOf("?") + 1);
  const starts = new URLSearchParams(query).getAll("bbox_start");
  return Number(starts[0]) / CHUNK_SIZE[0];
}

function distinctChunks(count: number): SavedChunk[] {
  return Array.from({ length: count }, (_unused, index) =>
    fakeChunk({ x: index, y: 0, z: 0 }),
  );
}

function okResponse(): Response {
  return new Response("", { status: 200 });
}

const noop = () => {};

function makeConcurrencyProbe(target: number) {
  let inFlight = 0;
  let maxInFlight = 0;
  let openGate: () => void = noop;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const request = vi.fn(async (_path: string, _init?: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    (inFlight === target ? openGate : noop)();
    await Promise.race([gate, sleep(10)]);
    inFlight -= 1;
    return okResponse();
  });
  return { request, maxInFlight: () => maxInFlight };
}

function makeAbortingProbe(settleTarget: number, controller: AbortController) {
  let settled = 0;
  const abort = () => controller.abort();
  return vi.fn(async (_path: string, _init?: RequestInit) => {
    await sleep(3);
    settled += 1;
    (settled === settleTarget ? abort : noop)();
    return okResponse();
  });
}

const mixedOutcomes: Record<string, () => Promise<Response>> = {
  fail: () => Promise.reject(new Error("upload failed")),
  ok: () => Promise.resolve(okResponse()),
};

function makeMixedProbe(failEvery: number) {
  return vi.fn(async (path: string, _init?: RequestInit) => {
    await sleep(1);
    return mixedOutcomes[
      chunkIndexFromPath(path) % failEvery === 0 ? "fail" : "ok"
    ]();
  });
}

interface AggregateShape {
  succeeded: number;
  failed: number;
  details: string;
}

function asAggregate(result: unknown): AggregateShape {
  return result as AggregateShape;
}

describe("HttpSaveBackend.saveLayer parallel uploads", () => {
  it("uploads every chunk exactly once without exceeding SAVE_UPLOAD_CONCURRENCY in flight", async () => {
    const chunkCount = 20;
    const probe = makeConcurrencyProbe(SAVE_UPLOAD_CONCURRENCY);
    const backend = new HttpSaveBackend({
      client: makeClient(probe.request),
      resolveDataSourceUrl: () => "gs://b/p",
    });

    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      distinctChunks(chunkCount),
      metadata,
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: "succeeded",
      layerId: "layer-1",
      chunkCount,
    });
    expect(probe.maxInFlight()).toBeLessThanOrEqual(SAVE_UPLOAD_CONCURRENCY);
    expect(probe.maxInFlight()).toBe(SAVE_UPLOAD_CONCURRENCY);
    expect(probe.request).toHaveBeenCalledTimes(chunkCount);
    const uploaded = probe.request.mock.calls
      .map(([path]) => chunkIndexFromPath(path))
      .sort((a, b) => a - b);
    expect(uploaded).toEqual(
      Array.from({ length: chunkCount }, (_unused, index) => index),
    );
  });

  it("stops dispatching and reports cancelled counts when the signal aborts mid-pool", async () => {
    const chunkCount = 20;
    const controller = new AbortController();
    const request = makeAbortingProbe(6, controller);
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });

    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      distinctChunks(chunkCount),
      metadata,
      controller.signal,
    );

    expect(result).toMatchObject({ status: "partial", layerId: "layer-1" });
    const aggregate = asAggregate(result);
    const match = /^cancelled-after-(\d+)-of-(\d+)$/.exec(aggregate.details);
    expect(match).not.toBeNull();
    const settled = Number(match?.[1]);
    expect(aggregate.succeeded + aggregate.failed).toBe(settled);
    expect(Number(match?.[2])).toBe(chunkCount);
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThan(chunkCount);
    expect(request.mock.calls.length).toBeLessThan(chunkCount);
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(settled);
  });

  it("aggregates mixed successes and failures across the pool into a partial result", async () => {
    const chunkCount = 12;
    const request = makeMixedProbe(3);
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });

    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      distinctChunks(chunkCount),
      metadata,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "partial",
      layerId: "layer-1",
      succeeded: 8,
      failed: 4,
      details: "upload failed",
    });
    const aggregate = asAggregate(result);
    expect(aggregate.succeeded + aggregate.failed).toBe(chunkCount);
    expect(request).toHaveBeenCalledTimes(chunkCount);
  });
});

/** A 409 carrying the backend's structured conditional-write-conflict body. */
function conflictError(detail = "conditional_write_conflict"): HttpError {
  return HttpError.fromResponse(
    new Response(
      JSON.stringify({
        detail,
        retryable: true,
        partially_applied: true,
        chunk: "8_8_40/0-512_0-512_0-1",
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
  );
}

describe("HttpSaveBackend conditional-write conflicts", () => {
  function backend(request: BackendClient["request"]): HttpSaveBackend {
    return new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });
  }

  it("replays the chunk after a lost CAS race and reports success", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(okResponse());

    const result = await backend(request).saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 0, y: 0, z: 0 })],
      metadata,
      new AbortController().signal,
    );

    expect(request).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      status: "succeeded",
      layerId: "layer-1",
      chunkCount: 1,
    });
  });

  it("gives up after exhausting the replay budget", async () => {
    const request = vi.fn().mockRejectedValue(conflictError());

    const result = await backend(request).saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 0, y: 0, z: 0 })],
      metadata,
      new AbortController().signal,
    );

    // One initial attempt plus one per backoff step.
    expect(request).toHaveBeenCalledTimes(4);
    expect(result.status).toBe("failed");
  });

  it("does not replay a 409 that is not a conditional-write conflict", async () => {
    const request = vi.fn().mockRejectedValue(conflictError("some_other_409"));

    const result = await backend(request).saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 0, y: 0, z: 0 })],
      metadata,
      new AbortController().signal,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
  });

  it("does not replay a non-409 failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("boom"));

    await backend(request).saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 0, y: 0, z: 0 })],
      metadata,
      new AbortController().signal,
    );

    expect(request).toHaveBeenCalledTimes(1);
  });
});

/** Decompress a gzipped request body back to raw voxel bytes. */
async function gunzip(body: ArrayBuffer): Promise<Uint8Array> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(body));
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

describe("HttpSaveBackend writes only the owned sub-box", () => {
  const SMALL: readonly [number, number, number] = [4, 3, 2];

  /** A 4x3x2 chunk filled with each voxel's linear index. */
  function partlyOwnedChunk(ownedBox: {
    start: [number, number, number];
    end: [number, number, number];
  }): SavedChunk {
    const bytes = new Uint8Array(4 * 3 * 2).map((_unused, index) => index);
    const owned: OwnedRegion = {
      chunkDataSize: SMALL,
      bytesPerVoxel: 1,
      channels: 1,
      chunkBox: { start: [0, 0, 0], end: [4, 3, 2] },
      ownedBox,
      coversWholeChunk: false,
      hash: "sub-box-hash",
    };
    return {
      layerId: "layer-1" as LayerId,
      resolution: "8x8x40",
      chunkId: "0,0,0",
      chunkCoord: { x: 0, y: 0, z: 0 },
      bytes: { asView: () => bytes },
      owned,
    } as unknown as SavedChunk;
  }

  it("posts the owned bbox, not the chunk bbox", async () => {
    // Reverting the clip — posting the whole chunk's bbox and body — is the
    // neighbour-clobbering write this PR exists to remove, so it has to be
    // visible here rather than only at the planner.
    const request = vi.fn(async (_path: string, _init?: RequestInit) =>
      okResponse(),
    );
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });

    await backend.saveLayer(
      "layer-1" as LayerId,
      [partlyOwnedChunk({ start: [1, 0, 0], end: [3, 3, 2] })],
      metadata,
      new AbortController().signal,
    );

    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(params.getAll("bbox_start")).toEqual(["1", "0", "0"]);
    expect(params.getAll("bbox_end")).toEqual(["3", "3", "2"]);

    // And the BODY is the sub-box, not the whole chunk.
    const sent = await gunzip(init.body as ArrayBuffer);
    const whole = new Uint8Array(4 * 3 * 2).map((_unused, i) => i);
    expect(Array.from(sent)).toEqual(
      Array.from(
        ownedRegionBytes(whole, {
          chunkDataSize: SMALL,
          bytesPerVoxel: 1,
          channels: 1,
          chunkBox: { start: [0, 0, 0], end: [4, 3, 2] },
          ownedBox: { start: [1, 0, 0], end: [3, 3, 2] },
          coversWholeChunk: false,
          hash: "",
        }),
      ),
    );
    expect(sent.length).toBeLessThan(whole.length);
  });

  it("refuses a chunk that arrives without an owned region", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) =>
      okResponse(),
    );
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });
    const unplanned = {
      layerId: "layer-1" as LayerId,
      resolution: "8x8x40",
      chunkId: "0,0,0",
      chunkCoord: { x: 0, y: 0, z: 0 },
      bytes: { asView: () => new Uint8Array(24) },
    } as unknown as SavedChunk;

    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [unplanned],
      metadata,
      new AbortController().signal,
    );

    expect(request).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    // Match the guard's own wording: without it `sendChunk` still fails, but
    // with a TypeError on `ownedBox` rather than a message naming the cause.
    expect(result).toMatchObject({
      error: expect.stringContaining("may not own"),
    });
  });
});
