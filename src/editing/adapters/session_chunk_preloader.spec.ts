/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, OverlayCoord, Resolution } from "@zettaai/edit-session";
import { ChunkId as ChunkIdFactory } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import { CapacitySpecification } from "#src/chunk_manager/frontend.js";
import {
  pinBudgetFor,
  PRELOAD_POOL_SIZE,
  preloadPoolSizeFor,
  SessionChunkPreloader,
} from "#src/editing/adapters/session_chunk_preloader.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";

interface PermCall {
  readonly key: string;
  readonly permanent: boolean;
}

interface FakeSource {
  readonly source: VolumeChunkSource;
  readonly perm: PermCall[];
  /** Keys of every fetch started, in order. */
  readonly fetched: string[];
}

/**
 * Minimal fake `VolumeChunkSource` exercising only what the preloader touches:
 * `spec.rank`, `chunkManager.markChunkPermanent`, and `fetchChunk`.
 * `fetchKey(key)` decides whether a given chunk's fetch resolves or rejects;
 * `chunk` is what the fetch hands to `transform` (its resident data). Like the
 * real one, a fetch rejects as soon as its signal aborts.
 */
function makeFakeSource(
  fetchKey: (key: string) => Promise<void>,
  rank = 3,
  chunk: unknown = undefined,
): FakeSource {
  const perm: PermCall[] = [];
  const fetched: string[] = [];
  const chunkManager = {
    markChunkPermanent(_s: unknown, key: string, permanent: boolean): void {
      perm.push({ key, permanent });
    },
  };
  const source = {
    spec: { rank },
    chunkManager,
    async fetchChunk(
      grid: Float32Array,
      transform: (chunk: unknown) => void,
      options: { signal?: AbortSignal } = {},
    ): Promise<void> {
      const key = grid.join();
      fetched.push(key);
      const { signal } = options;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => reject(signal!.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        fetchKey(key)
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", onAbort));
      });
      transform(chunk);
    },
  };
  return { source: source as unknown as VolumeChunkSource, perm, fetched };
}

/** Let every pending fetch settle and the pool move on. */
function settleFetches(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const OPTIONS = { poolSize: PRELOAD_POOL_SIZE };

function coord(x: number, y: number, z: number, layerId = "seg"): OverlayCoord {
  return {
    layerId: layerId as LayerId,
    resolution: "8x8x8" as Resolution,
    chunkId: ChunkIdFactory.fromCoord({ x, y, z }),
  };
}

describe("SessionChunkPreloader", () => {
  it("loads every chunk, pins each once, and ends in done with no failures", async () => {
    const fake = makeFakeSource(() => Promise.resolve());
    const preloader = new SessionChunkPreloader(() => fake.source, OPTIONS);
    const coords = [coord(0, 0, 0), coord(1, 0, 0), coord(2, 0, 0)];

    await preloader.start(coords, new AbortController().signal);

    expect(preloader.progress.value).toEqual({
      kind: "done",
      total: 3,
      failed: 0,
      failures: [],
    });
    expect(fake.perm).toEqual([
      { key: "0,0,0", permanent: true },
      { key: "1,0,0", permanent: true },
      { key: "2,0,0", permanent: true },
    ]);
  });

  it("records a genuine fetch rejection as a failure (not a zero baseline)", async () => {
    // A sparse / absent chunk RESOLVES with null data — it never rejects — so a
    // rejection here is a real fetch error (5xx, network, decode). It must be
    // surfaced as a failure, not masked as loaded: the lazy `readBaselineChunk`
    // now retries and then throws rather than returning a false-empty baseline.
    const fake = makeFakeSource((key) =>
      key === "1,0,0"
        ? Promise.reject(new Error("network"))
        : Promise.resolve(),
    );
    const preloader = new SessionChunkPreloader(() => fake.source, OPTIONS);
    const coords = [coord(0, 0, 0), coord(1, 0, 0), coord(2, 0, 0)];

    await preloader.start(coords, new AbortController().signal);

    expect(preloader.progress.value).toEqual({
      kind: "done",
      total: 3,
      failed: 1,
      failures: [{ layerId: "seg", resolution: "8x8x8", count: 1 }],
    });
    // Only the two resolved chunks get pinned; the failed one is not.
    expect(fake.perm).toEqual([
      { key: "0,0,0", permanent: true },
      { key: "2,0,0", permanent: true },
    ]);
  });

  it("records a source-resolution failure without aborting the rest", async () => {
    const fake = makeFakeSource(() => Promise.resolve());
    const preloader = new SessionChunkPreloader((layerId) => {
      if (layerId === ("missing" as LayerId)) {
        throw new Error("layer-not-found");
      }
      return fake.source;
    }, OPTIONS);
    const good = coord(0, 0, 0);
    const bad: OverlayCoord = {
      layerId: "missing" as LayerId,
      resolution: "8x8x8" as Resolution,
      chunkId: ChunkIdFactory.fromCoord({ x: 9, y: 9, z: 9 }),
    };

    await preloader.start([good, bad], new AbortController().signal);

    const state = preloader.progress.value;
    expect(state.kind).toBe("done");
    if (state.kind !== "done") throw new Error("unreachable");
    expect(state.failed).toBe(1);
    expect(state.failures).toEqual([
      { layerId: "missing", resolution: "8x8x8", count: 1 },
    ]);
    // The good layer still loaded + pinned.
    expect(fake.perm.filter((c) => c.permanent)).toHaveLength(1);
  });

  it("release() unmarks every pinned chunk exactly once and is idempotent", async () => {
    const fake = makeFakeSource(() => Promise.resolve());
    const preloader = new SessionChunkPreloader(() => fake.source, OPTIONS);
    await preloader.start(
      [coord(0, 0, 0), coord(1, 0, 0)],
      new AbortController().signal,
    );

    preloader.release();
    const unpins = fake.perm.filter((c) => !c.permanent);
    expect(unpins).toHaveLength(2);
    expect(preloader.progress.value).toEqual({ kind: "idle" });

    // Second release is a no-op.
    preloader.release();
    expect(fake.perm.filter((c) => !c.permanent)).toHaveLength(2);
  });

  it("does not transition to done when aborted before starting", async () => {
    const fake = makeFakeSource(() => Promise.resolve());
    const preloader = new SessionChunkPreloader(() => fake.source, OPTIONS);
    const controller = new AbortController();
    controller.abort();

    await preloader.start([coord(0, 0, 0), coord(1, 0, 0)], controller.signal);

    // Aborted before any fetch launched: never reaches "done", nothing pinned.
    expect(preloader.progress.value.kind).not.toBe("done");
    expect(fake.perm.filter((c) => c.permanent)).toHaveLength(0);
  });

  it("stops pinning once the pinned set reaches its memory budget", async () => {
    // Ten 100-byte chunks against a 300-byte budget: three pin, and the other
    // seven stay ordinary, evictable chunks.
    const fake = makeFakeSource(() => Promise.resolve(), 3, {
      data: new Uint8Array(100),
    });
    const preloader = new SessionChunkPreloader(() => fake.source, {
      pinBudgetBytes: () => 300,
      poolSize: 1,
    });
    const coords = Array.from({ length: 10 }, (_, i) => coord(i, 0, 0));

    await preloader.start(coords, new AbortController().signal);

    expect(fake.perm).toEqual(
      ["0,0,0", "1,0,0", "2,0,0"].map((key) => ({ key, permanent: true })),
    );
    expect(preloader.progress.value).toEqual({
      kind: "done",
      total: 10,
      failed: 0,
      failures: [],
      skipped: 7,
    });
    // The fourth chunk is the one that met the budget; nothing past it is
    // fetched.
    expect(fake.fetched).toEqual(["0,0,0", "1,0,0", "2,0,0", "3,0,0"]);

    // Release unpins exactly the chunks that were pinned.
    preloader.release();
    expect(fake.perm.filter((c) => !c.permanent)).toEqual(
      ["0,0,0", "1,0,0", "2,0,0"].map((key) => ({ key, permanent: false })),
    );
  });

  it("at the budget, cancels the fetches still in flight", async () => {
    // Three in flight; the second to land meets a 150-byte budget, so the
    // third is cancelled and nothing past it is fetched.
    const held = new Map<string, () => void>();
    const fake = makeFakeSource(
      (key) =>
        new Promise<void>((resolve) => {
          held.set(key, resolve);
        }),
      3,
      { data: new Uint8Array(100) },
    );
    const preloader = new SessionChunkPreloader(() => fake.source, {
      pinBudgetBytes: () => 150,
      poolSize: 3,
    });
    const coords = Array.from({ length: 5 }, (_, i) => coord(i, 0, 0));
    const done = preloader.start(coords, new AbortController().signal);

    held.get("0,0,0")!();
    await settleFetches();
    held.get("1,0,0")!();
    await done;

    expect(fake.fetched).toEqual(["0,0,0", "1,0,0", "2,0,0", "3,0,0"]);
    expect(fake.perm).toEqual([{ key: "0,0,0", permanent: true }]);
    expect(preloader.progress.value).toEqual({
      kind: "done",
      total: 5,
      failed: 0,
      failures: [],
      skipped: 4,
    });
  });

  it("gives the pin budget to the layers that pin first", async () => {
    // Two 100-byte chunks per layer against a 200-byte budget. The reference
    // layer comes first in the config, but the painted one is pinned.
    const chunk = { data: new Uint8Array(100) };
    const reference = makeFakeSource(() => Promise.resolve(), 3, chunk);
    const painted = makeFakeSource(() => Promise.resolve(), 3, chunk);
    const preloader = new SessionChunkPreloader(
      (layerId) =>
        layerId === ("painted" as LayerId) ? painted.source : reference.source,
      {
        pinBudgetBytes: () => 200,
        poolSize: 1,
        pinsFirst: (layerId) => layerId === ("painted" as LayerId),
      },
    );
    const coords = [
      coord(0, 0, 0, "reference"),
      coord(1, 0, 0, "reference"),
      coord(0, 0, 0, "painted"),
      coord(1, 0, 0, "painted"),
    ];

    await preloader.start(coords, new AbortController().signal);

    expect(painted.perm).toEqual(
      ["0,0,0", "1,0,0"].map((key) => ({ key, permanent: true })),
    );
    expect(reference.perm).toEqual([]);
    expect(preloader.progress.value).toMatchObject({ skipped: 2 });
  });

  it("pins a chunk shared by two layers once, and unpins it once", async () => {
    // Two session layers on one volume share its chunk source. A budget with
    // room for one chunk must not count the shared chunk twice.
    const fake = makeFakeSource(() => Promise.resolve(), 3, {
      data: new Uint8Array(100),
    });
    const preloader = new SessionChunkPreloader(() => fake.source, {
      pinBudgetBytes: () => 100,
      poolSize: 1,
    });

    await preloader.start(
      [coord(0, 0, 0, "reference"), coord(0, 0, 0, "painted")],
      new AbortController().signal,
    );

    expect(preloader.progress.value).toEqual({
      kind: "done",
      total: 2,
      failed: 0,
      failures: [],
    });
    preloader.release();
    expect(fake.perm).toEqual([
      { key: "0,0,0", permanent: true },
      { key: "0,0,0", permanent: false },
    ]);
  });

  it("on a session abort mid-load, cancels the fetches and release unpins only what landed", async () => {
    const held = new Map<string, () => void>();
    const fake = makeFakeSource(
      (key) =>
        new Promise<void>((resolve) => {
          held.set(key, resolve);
        }),
    );
    const preloader = new SessionChunkPreloader(() => fake.source, {
      poolSize: 2,
    });
    const controller = new AbortController();
    const done = preloader.start(
      [coord(0, 0, 0), coord(1, 0, 0), coord(2, 0, 0)],
      controller.signal,
    );

    held.get("0,0,0")!();
    await settleFetches();
    controller.abort();
    await done;

    expect(fake.fetched).toEqual(["0,0,0", "1,0,0", "2,0,0"]);
    expect(preloader.progress.value.kind).toBe("loading");
    preloader.release();
    expect(fake.perm).toEqual([
      { key: "0,0,0", permanent: true },
      { key: "0,0,0", permanent: false },
    ]);
  });

  it("does not pin a chunk whose fetch settles after release", async () => {
    let settle: () => void = () => {};
    const fake = makeFakeSource(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const preloader = new SessionChunkPreloader(() => fake.source, OPTIONS);
    const done = preloader.start(
      [coord(0, 0, 0)],
      new AbortController().signal,
    );
    await Promise.resolve();

    preloader.release();
    settle();
    await done;

    expect(fake.perm).toEqual([]);
    expect(preloader.progress.value).toEqual({ kind: "idle" });
  });

  it("keeps poolSize fetches in flight, and no more", async () => {
    // Fetches stay open until released, so the pool's width is observable.
    const held: (() => void)[] = [];
    let maxInFlight = 0;
    const fake = makeFakeSource(
      () =>
        new Promise<void>((resolve) => {
          held.push(resolve);
          maxInFlight = Math.max(maxInFlight, held.length);
        }),
    );
    const preloader = new SessionChunkPreloader(() => fake.source, OPTIONS);
    const coords = Array.from({ length: PRELOAD_POOL_SIZE + 50 }, (_, i) =>
      coord(i, 0, 0),
    );
    const done = preloader.start(coords, new AbortController().signal);

    // fetchChunk awaits its key before parking the fetch.
    await Promise.resolve();
    expect(held).toHaveLength(PRELOAD_POOL_SIZE);
    while (held.length > 0) {
      held.splice(0).forEach((resolve) => resolve());
      await settleFetches();
    }
    await done;
    expect(maxInFlight).toBe(PRELOAD_POOL_SIZE);
    expect(preloader.progress.value).toMatchObject({
      kind: "done",
      total: PRELOAD_POOL_SIZE + 50,
    });
  });
});

describe("pinBudgetFor", () => {
  it("is 60% of the smaller of the GPU and system memory limits", () => {
    const capacities = (gpuBytes: number, systemBytes: number) => ({
      gpuMemory: new CapacitySpecification({ defaultSizeLimit: gpuBytes }),
      systemMemory: new CapacitySpecification({
        defaultSizeLimit: systemBytes,
      }),
    });
    expect(pinBudgetFor(capacities(1000, 2000))).toBe(600);
    expect(pinBudgetFor(capacities(2000, 1000))).toBe(600);
  });
});

describe("preloadPoolSizeFor", () => {
  const download = (itemLimit: number) =>
    new CapacitySpecification({ defaultItemLimit: itemLimit });

  it("takes half of neuroglancer's download slots", () => {
    expect(preloadPoolSizeFor(download(100))).toBe(50);
    expect(preloadPoolSizeFor(download(9))).toBe(4);
  });

  it("is never more than PRELOAD_POOL_SIZE", () => {
    expect(preloadPoolSizeFor(download(1000))).toBe(PRELOAD_POOL_SIZE);
    expect(preloadPoolSizeFor(download(Number.POSITIVE_INFINITY))).toBe(
      PRELOAD_POOL_SIZE,
    );
  });

  it("keeps at least one fetch in flight", () => {
    expect(preloadPoolSizeFor(download(1))).toBe(1);
  });
});
