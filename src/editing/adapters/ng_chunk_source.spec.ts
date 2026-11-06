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
  ChunkVoxelBuffer,
  LayerId,
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdFactory,
  ChunkReadAbortedError,
  ChunkReadFailedError,
  contentRefFromBuffer,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import {
  decodeBaselineChunk,
  fetchBaselineWithRetry,
  NgChunkSource,
  readBaselineBox,
} from "#src/editing/adapters/ng_chunk_source.js";
import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import type {
  ChunkOwnedGeometry,
  OwnedRegion,
} from "#src/editing/region/owned_chunk_write.js";
import { ownedRegionHash } from "#src/editing/region/owned_chunk_write.js";

import type { LayerManager } from "#src/layer/index.js";
import { encodeChannels } from "#src/sliceview/compressed_segmentation/encode_uint64.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { TypedArrayBuilder } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";

const COORD: OverlayCoord = {
  layerId: "seg" as OverlayCoord["layerId"],
  resolution: "8x8x8" as OverlayCoord["resolution"],
  chunkId: ChunkIdFactory.fromCoord({ x: 0, y: 0, z: 0 }),
};
const GRID = new Float32Array([0, 0, 0]);

interface FetchResult {
  readonly data: ChunkVoxelBuffer | null;
}

/**
 * Minimal fake `VolumeChunkSource` exercising only what
 * `fetchBaselineWithRetry` touches: `spec` (for the zero-fill path) and
 * `fetchChunk`, which awaits `respond(attempt)` then runs the caller's
 * transform with `{ data }`. A rejecting `respond` simulates a thrown fetch
 * error; resolving with `data: null` simulates a sparse / absent chunk.
 */
function makeSource(respond: (attempt: number) => Promise<FetchResult>): {
  source: VolumeChunkSource;
  calls: () => number;
} {
  let calls = 0;
  const source = {
    spec: {
      chunkDataSize: [2, 2, 2],
      dataType: DataType.UINT32,
      compressedSegmentationBlockSize: undefined,
    },
    async fetchChunk(
      _grid: Float32Array,
      transform: (chunk: unknown) => ChunkVoxelBuffer,
    ): Promise<ChunkVoxelBuffer> {
      const attempt = calls++;
      const chunk = await respond(attempt);
      return transform(chunk);
    },
  };
  return { source: source as unknown as VolumeChunkSource, calls: () => calls };
}

describe("fetchBaselineWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the chunk bytes when the fetch succeeds on the first try", async () => {
    const bytes = Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const { source, calls } = makeSource(async () => ({ data: bytes }));

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint32Array)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(calls()).toBe(1);
  });

  it("zero-fills a sparse chunk (null data) without retrying", async () => {
    const { source, calls } = makeSource(async () => ({ data: null }));

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    // 2x2x2 UINT32 → eight zero voxels.
    expect(Array.from(result.asView() as Uint32Array)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(calls()).toBe(1);
  });

  it("retries a transient error and succeeds", async () => {
    const bytes = Uint32Array.from([9, 9, 9, 9, 9, 9, 9, 9]);
    const { source, calls } = makeSource(async (attempt) => {
      if (attempt < 2) throw new Error("transient");
      return { data: bytes };
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint32Array)).toEqual([
      9, 9, 9, 9, 9, 9, 9, 9,
    ]);
    expect(calls()).toBe(3);
  });

  it("propagates ChunkReadFailedError after exhausting retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = new Error("persistent failure");
    const { source, calls } = makeSource(async () => {
      throw cause;
    });

    const error = await fetchBaselineWithRetry(
      source,
      COORD,
      GRID,
      undefined,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ChunkReadFailedError);
    expect(calls()).toBe(3);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("throws ChunkReadAbortedError without fetching when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { source, calls } = makeSource(async () => ({ data: null }));

    const error = await fetchBaselineWithRetry(
      source,
      COORD,
      GRID,
      controller.signal,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ChunkReadAbortedError);
    expect(calls()).toBe(0);
  });

  it("throws ChunkReadAbortedError when the signal aborts during a fetch", async () => {
    const controller = new AbortController();
    const { source, calls } = makeSource(async () => {
      // Abort mid-flight, then fail: the post-catch abort check must win over
      // a retry, surfacing an abort (not a read failure).
      controller.abort();
      throw new Error("interrupted");
    });

    const error = await fetchBaselineWithRetry(
      source,
      COORD,
      GRID,
      controller.signal,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ChunkReadAbortedError);
    expect(calls()).toBe(1);
  });
});

/**
 * Fake `VolumeChunkSource` for the edge-chunk padding path (TM-353): `spec`
 * carries the NOMINAL `chunkDataSize`; `fetchChunk` hands the transform a chunk
 * with the given `data` and (optionally) an edge-clipped `chunkDataSize`,
 * mimicking how NG exposes a boundary chunk's actual extent on
 * `VolumeChunk.chunkDataSize`.
 */
function makeEdgeSource(
  data: ArrayBufferView | null,
  opts: {
    chunkDataSize: number[];
    clipped?: number[];
    /** The volume's `upperVoxelBound` (lower is 0); absent → unknown extent. */
    volumeSize?: number[];
  },
): VolumeChunkSource {
  const source = {
    spec: {
      rank: 3,
      chunkDataSize: opts.chunkDataSize,
      dataType: DataType.UINT8,
      compressedSegmentationBlockSize: undefined,
      ...(opts.volumeSize !== undefined && {
        lowerVoxelBound: [0, 0, 0],
        upperVoxelBound: opts.volumeSize,
      }),
    },
    async fetchChunk(
      _grid: Float32Array,
      transform: (chunk: unknown) => ChunkVoxelBuffer,
    ): Promise<ChunkVoxelBuffer> {
      const chunk =
        opts.clipped === undefined
          ? { data }
          : { data, chunkDataSize: Uint32Array.from(opts.clipped) };
      return transform(chunk);
    },
  };
  return source as unknown as VolumeChunkSource;
}

describe("decodeBaselineChunk edge-chunk padding (TM-353)", () => {
  it("pads a boundary chunk (data smaller than nominal) into the low corner", async () => {
    // NG decodes this 4x4 chunk clipped to its 2x2 data extent; the library
    // indexes slots with the nominal 4x4 stride, so the baseline must be the
    // full 16-voxel nominal buffer with the 2x2 data in the corner and zeros
    // elsewhere — otherwise the nominal-stride write/fuse overruns the 4-voxel
    // clipped buffer.
    const source = makeEdgeSource(Uint8Array.from([1, 2, 3, 4]), {
      chunkDataSize: [4, 4, 1],
      clipped: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual([
      1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("leaves an interior chunk (already nominal) unchanged", async () => {
    const full = Uint8Array.from([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const source = makeEdgeSource(full, {
      chunkDataSize: [4, 4, 1],
      clipped: [4, 4, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual(Array.from(full));
  });

  it("pads a z-clipped chunk into the first slice", async () => {
    // Nominal 2x2x2, data clipped to the first z-slice (2x2x1) → four voxels in
    // slice 0, the second slice zero.
    const source = makeEdgeSource(Uint8Array.from([1, 2, 3, 4]), {
      chunkDataSize: [2, 2, 2],
      clipped: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual([
      1, 2, 3, 4, 0, 0, 0, 0,
    ]);
  });

  it("zero-fills a sparse (null-data) edge chunk at the nominal size", async () => {
    const source = makeEdgeSource(null, {
      chunkDataSize: [4, 4, 1],
      clipped: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    const view = result.asView() as Uint8Array;
    expect(view.length).toBe(16);
    expect(Array.from(view).every((v) => v === 0)).toBe(true);
  });
});

describe("decodeBaselineChunk on an axis the volume fills with one chunk (TM-373)", () => {
  it("returns the volume-sized chunk without padding to nominal", async () => {
    // A 2×2×1 volume in 4×4×1 chunks: the session chunk is the volume's 2×2×1.
    const source = makeEdgeSource(Uint8Array.from([1, 2, 3, 4]), {
      chunkDataSize: [4, 4, 1],
      clipped: [2, 2, 1],
      volumeSize: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it("still pads the axes that have several chunks", async () => {
    // x fits one chunk (2 of 4); y has two chunks (6 of 4): an edge chunk
    // clipped to 2×2 keeps x at 2 and pads y to the nominal 4.
    const source = makeEdgeSource(Uint8Array.from([1, 2, 3, 4]), {
      chunkDataSize: [4, 4, 1],
      clipped: [2, 2, 1],
      volumeSize: [2, 6, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual([
      1, 2, 3, 4, 0, 0, 0, 0,
    ]);
  });

  it("zero-fills a sparse chunk at the volume size", async () => {
    const source = makeEdgeSource(null, {
      chunkDataSize: [4, 4, 1],
      clipped: [2, 2, 1],
      volumeSize: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual([0, 0, 0, 0]);
  });

  it("falls back to the volume size when NG gives no clipped size", async () => {
    const source = makeEdgeSource(Uint8Array.from([1, 2, 3, 4]), {
      chunkDataSize: [4, 4, 1],
      volumeSize: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual([1, 2, 3, 4]);
  });
});

const LAYER = "seg" as LayerId;
const RES_8 = ResolutionCtor.from([8, 8, 8]);
const CHUNK_ID = ChunkIdFactory.fromCoord({ x: 0, y: 0, z: 0 });
const CHUNK_COORD = { x: 0, y: 0, z: 0 };
// 2x2x2 UINT32 chunk → eight voxels (matches the fake source's chunkDataSize).
const SAVED = Uint32Array.from([10, 11, 12, 13, 14, 15, 16, 17]);

function buffer(bytes: Uint32Array): ReadonlyChunkVoxelBuffer {
  return { byteLength: bytes.byteLength, asView: () => bytes };
}

interface FakeVolumeSource {
  spec: {
    rank: number;
    chunkDataSize: number[];
    dataType: DataType;
    compressedSegmentationBlockSize: undefined;
  };
  fetchFreshDecodedChunk: (
    grid: Float32Array,
    signal: AbortSignal,
  ) => Promise<{
    data: ArrayBufferView | null;
    chunkDataSize: Uint32Array | null;
  }>;
  fetchChunk?: (
    grid: Float32Array,
    transform: (chunk: { data: ArrayBufferView | null }) => ChunkVoxelBuffer,
  ) => Promise<ChunkVoxelBuffer>;
  invalidateChunkCache: ReturnType<typeof vi.fn>;
  /** Resident chunks, keyed as NG keys them: `chunkGridPosition.join()`. */
  chunks: Map<string, unknown>;
}

/**
 * Fake `VolumeChunkSource` exercising what the read-back verification touches:
 * `spec` (for resolution resolution + `decodeBaselineChunk`) and the
 * non-evicting `fetchFreshDecodedChunk`. `readBack` controls what storage
 * returns: a `Uint32Array` (decoded bytes), `null` (sparse/empty → zero-filled),
 * or `"throw"` (read failure → caller retries).
 */
function fakeSource(
  readBack: Uint32Array | null | "throw",
  datasource?: Uint32Array | null,
): FakeVolumeSource {
  return {
    spec: {
      rank: 3,
      chunkDataSize: [2, 2, 2],
      dataType: DataType.UINT32,
      compressedSegmentationBlockSize: undefined,
    },
    fetchFreshDecodedChunk: () => {
      if (readBack === "throw") return Promise.reject(new Error("read failed"));
      return Promise.resolve({
        data: readBack,
        chunkDataSize: Uint32Array.from([2, 2, 2]),
      });
    },
    // The datasource render-base read path (`readDatasourceBaseline` →
    // `fetchBaselineWithRetry` → `source.fetchChunk`). Only wired when a
    // `datasource` buffer is supplied.
    fetchChunk:
      datasource === undefined
        ? undefined
        : (_grid, transform) =>
            Promise.resolve(transform({ data: datasource })),
    invalidateChunkCache: vi.fn(),
    chunks: new Map(),
  };
}

/**
 * Build an `NgChunkSource` whose single `(LAYER, RES_8)` scale resolves to
 * `source`. Mirrors what `resolveVolumeChunkSource` walks: `getLayerByName →
 * layer.dataSources[].loadState → subsources[].subsourceEntry.subsource.volume`
 * plus the [8,8,8] model resolution from `modelTransform.outputSpace`.
 */
function makeChunkSourceResolving(source: FakeVolumeSource): NgChunkSource {
  const diag = new Float32Array(16);
  diag[0] = diag[5] = diag[10] = 1; // relativeScale 1 → 8nm
  const volume = {
    rank: 3,
    getSources: () => [
      [{ chunkSource: source, chunkToMultiscaleTransform: diag }],
    ],
  };
  const loadState = {
    subsources: [{ subsourceEntry: { subsource: { volume } } }],
    dataSource: {
      modelTransform: {
        outputSpace: { scales: [8e-9, 8e-9, 8e-9], units: ["m", "m", "m"] },
      },
    },
  };
  const userLayer = { dataSources: [{ loadState }] };
  const layerManager = {
    getLayerByName: (name: string) =>
      name === LAYER ? { layer: userLayer } : undefined,
  };
  return new NgChunkSource(
    layerManager as unknown as LayerManager,
    {} as unknown as ChunkManager,
  );
}

describe("NgChunkSource saved-baseline (re-entry)", () => {
  it("readBaselineChunk returns the client-retained saved bytes", async () => {
    // The fake source has no `fetchChunk`, so a fall-through to the datasource
    // would throw — returning SAVED proves the saved-baseline short-circuit.
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    const result = await chunkSource.readBaselineChunk(
      LAYER,
      RES_8,
      CHUNK_ID,
      CHUNK_COORD,
    );

    expect(Array.from(result.asView() as Uint32Array)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  it("keeps the saved buffer itself, without a copy (TM-373)", async () => {
    // The saved bytes are the library's immutable content-ref buffer; a copy
    // was +128 MB per saved 4096² uint64 chunk.
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    const saved = buffer(SAVED);
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, saved);

    expect(chunkSource.getSavedBytes(LAYER, RES_8, CHUNK_ID)).toBe(saved);
    const read = await chunkSource.readBaselineChunk(
      LAYER,
      RES_8,
      CHUNK_ID,
      CHUNK_COORD,
    );
    expect(read.asView()).toBe(SAVED);
  });
});

describe("NgChunkSource.readDatasourceBaseline (render base)", () => {
  it("reads the datasource render base, ignoring the saved edit baseline", async () => {
    // The render composites the GPU patch over the datasource chunk, so the
    // PatchMirror mask must diff against THIS, not the saved bytes — otherwise
    // just-saved voxels drop out of the mask and revert on screen (TM-352).
    const DATASOURCE = Uint32Array.from([1, 1, 1, 1, 1, 1, 1, 1]);
    const source = fakeSource(SAVED.slice(), DATASOURCE.slice());
    const chunkSource = makeChunkSourceResolving(source);
    // Record DIFFERENT saved bytes; readDatasourceBaseline must NOT return them.
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    const datasource = await chunkSource.readDatasourceBaseline(
      LAYER,
      RES_8,
      CHUNK_ID,
      CHUNK_COORD,
    );
    const editBaseline = await chunkSource.readBaselineChunk(
      LAYER,
      RES_8,
      CHUNK_ID,
      CHUNK_COORD,
    );

    // readDatasourceBaseline → the datasource render base (all 1s).
    expect(Array.from(datasource.asView() as Uint32Array)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1,
    ]);
    // readBaselineChunk → still the saved edit baseline (proves they diverge).
    expect(Array.from(editBaseline.asView() as Uint32Array)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });
});

const OTHER = Uint32Array.from([90, 91, 92, 93, 94, 95, 96, 97]);

describe("NgChunkSource.confirmChunkPersisted", () => {
  const wholeChunkRegion = (bytes: Uint32Array): OwnedRegion => ({
    chunkDataSize: [2, 2, 2],
    bytesPerVoxel: 4,
    channels: 1,
    chunkBox: { start: [0, 0, 0], end: [2, 2, 2] },
    ownedBox: { start: [0, 0, 0], end: [2, 2, 2] },
    coversWholeChunk: true,
    hash: contentRefFromBuffer(bytes).hash,
  });

  it("confirms when the read-back matches the owned region's hash", async () => {
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    expect(
      await chunkSource.confirmChunkPersisted(
        LAYER,
        RES_8,
        CHUNK_COORD,
        wholeChunkRegion(SAVED),
      ),
    ).toBe(true);
  });

  it("rejects a read-back that does not match", async () => {
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    expect(
      await chunkSource.confirmChunkPersisted(
        LAYER,
        RES_8,
        CHUNK_COORD,
        wholeChunkRegion(OTHER),
      ),
    ).toBe(false);
  });

  it("confirms a partly-owned chunk even when the un-owned half differs", async () => {
    // The regression this whole change exists for: a neighbouring task has
    // repainted its half of a shared boundary chunk since we snapshotted.
    // Hashing the whole chunk could never match; hashing the owned half must.
    const ours = Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    // x:[0,1) — the first column of every row, i.e. indices 0,2,4,6.
    const firstColumn: ChunkOwnedGeometry = {
      chunkDataSize: [2, 2, 2],
      bytesPerVoxel: 4,
      channels: 1,
      chunkBox: { start: [0, 0, 0], end: [2, 2, 2] },
      ownedBox: { start: [0, 0, 0], end: [1, 2, 2] },
      coversWholeChunk: false,
    };
    const owned: OwnedRegion = {
      ...firstColumn,
      hash: ownedRegionHash(ours, firstColumn),
    };
    // Neighbour rewrote every odd index; ours (even indices) are untouched.
    const readBack = Uint32Array.from([1, 99, 3, 99, 5, 99, 7, 99]);
    const chunkSource = makeChunkSourceResolving(fakeSource(readBack));

    expect(
      await chunkSource.confirmChunkPersisted(LAYER, RES_8, CHUNK_COORD, owned),
    ).toBe(true);
  });

  it("rejects when OUR half of a shared chunk was clobbered", async () => {
    const ours = Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const geometry: ChunkOwnedGeometry = {
      chunkDataSize: [2, 2, 2],
      bytesPerVoxel: 4,
      channels: 1,
      chunkBox: { start: [0, 0, 0], end: [2, 2, 2] },
      ownedBox: { start: [0, 0, 0], end: [1, 2, 2] },
      coversWholeChunk: false,
    };
    const owned = { ...geometry, hash: ownedRegionHash(ours, geometry) };
    const readBack = Uint32Array.from([77, 2, 77, 4, 77, 6, 77, 8]);
    const chunkSource = makeChunkSourceResolving(fakeSource(readBack));

    expect(
      await chunkSource.confirmChunkPersisted(LAYER, RES_8, CHUNK_COORD, owned),
    ).toBe(false);
  });
});

describe("NgChunkSource exit reconciliation (TM-352)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clearSavedBaseline drops the retained saved bytes", () => {
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));
    expect(
      Array.from(
        chunkSource
          .getSavedBytes(LAYER, RES_8, CHUNK_ID)!
          .asView() as Uint32Array,
      ),
    ).toEqual(Array.from(SAVED));

    chunkSource.clearSavedBaseline();

    expect(chunkSource.getSavedBytes(LAYER, RES_8, CHUNK_ID)).toBeUndefined();
  });

  it("invalidateDatasourceChunks evicts the saved chunk's datasource cache key", () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    chunkSource.invalidateDatasourceChunks([
      { layerId: LAYER, resolution: RES_8, chunkCoord: CHUNK_COORD },
    ]);

    // makeChunkGridPosition({0,0,0}).join() === "0,0,0".
    expect(source.invalidateChunkCache).toHaveBeenCalledTimes(1);
    expect(source.invalidateChunkCache).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("batches multiple chunks of one source into a single eviction call", () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    chunkSource.invalidateDatasourceChunks([
      { layerId: LAYER, resolution: RES_8, chunkCoord: { x: 0, y: 0, z: 0 } },
      { layerId: LAYER, resolution: RES_8, chunkCoord: { x: 1, y: 2, z: 3 } },
    ]);

    expect(source.invalidateChunkCache).toHaveBeenCalledTimes(1);
    expect(source.invalidateChunkCache).toHaveBeenCalledWith([
      "0,0,0",
      "1,2,3",
    ]);
  });

  /**
   * "Reload all chunks", as a tracer means it: everything currently loaded for
   * the layer, not just the chunks this session painted. Takes the resident set
   * rather than enumerating the region's grid, because what is loaded is the
   * only thing that can be showing stale data.
   */
  it("invalidateLoadedChunks evicts every resident chunk of a scope", () => {
    const source = fakeSource(SAVED.slice());
    source.chunks.set("0,0,0", {});
    source.chunks.set("1,0,0", {});
    const chunkSource = makeChunkSourceResolving(source);

    const count = chunkSource.invalidateLoadedChunks([
      { layerId: LAYER, resolution: RES_8 },
    ]);

    expect(count).toBe(2);
    expect(source.invalidateChunkCache).toHaveBeenCalledTimes(1);
    expect(source.invalidateChunkCache).toHaveBeenCalledWith([
      "0,0,0",
      "1,0,0",
    ]);
  });

  it("invalidateLoadedChunks leaves a scope with nothing loaded alone", () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    expect(
      chunkSource.invalidateLoadedChunks([
        { layerId: LAYER, resolution: RES_8 },
      ]),
    ).toBe(0);
    expect(source.invalidateChunkCache).not.toHaveBeenCalled();
  });

  it("invalidateLoadedChunks skips a scope whose layer no longer resolves", () => {
    const source = fakeSource(SAVED.slice());
    source.chunks.set("0,0,0", {});
    const chunkSource = makeChunkSourceResolving(source);

    expect(
      chunkSource.invalidateLoadedChunks([
        { layerId: "gone" as LayerId, resolution: RES_8 },
      ]),
    ).toBe(0);
    expect(source.invalidateChunkCache).not.toHaveBeenCalled();
  });

  it("skips chunks whose layer no longer resolves to a source", () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    expect(() =>
      chunkSource.invalidateDatasourceChunks([
        {
          layerId: "gone" as LayerId,
          resolution: RES_8,
          chunkCoord: CHUNK_COORD,
        },
      ]),
    ).not.toThrow();
    expect(source.invalidateChunkCache).not.toHaveBeenCalled();
  });

  it("after clear, readBaselineChunk no longer short-circuits to the saved bytes", async () => {
    // The fake source has no `fetchChunk`, so once the saved short-circuit is
    // gone the baseline read falls through to the datasource and fails — proving
    // the cleared cache no longer shadows the backend on re-entry.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));
    chunkSource.clearSavedBaseline();

    await expect(
      chunkSource.readBaselineChunk(LAYER, RES_8, CHUNK_ID, CHUNK_COORD),
    ).rejects.toBeInstanceOf(ChunkReadFailedError);
  });
});

/** Cut `box` out of a dense chunk buffer of size `size`. */
function cropBox<T extends { length: number; [index: number]: unknown }>(
  full: T,
  size: readonly number[],
  box: ChunkVoxelBox,
): unknown[] {
  const out: unknown[] = [];
  for (let z = box.z0; z <= box.z1; z++) {
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        out.push(full[(z * size[1] + y) * size[0] + x]);
      }
    }
  }
  return out;
}

/** The spec fields `decodeBaselineChunk` / `readBaselineBox` read. */
function boxSource(opts: {
  chunkDataSize: number[];
  dataType: DataType;
  blockSize?: number[];
}): VolumeChunkSource {
  return {
    spec: {
      rank: 3,
      chunkDataSize: opts.chunkDataSize,
      dataType: opts.dataType,
      compressedSegmentationBlockSize:
        opts.blockSize === undefined
          ? undefined
          : Uint32Array.from(opts.blockSize),
    },
  } as unknown as VolumeChunkSource;
}

function chunkWith(data: ArrayBufferView | null, clipped: number[]) {
  return { data, chunkDataSize: Uint32Array.from(clipped) } as never;
}

describe("readBaselineBox (TM-373 PR 2)", () => {
  // A 64×64 uint64 edge chunk holding 37×29 of data, compressed with NG's
  // z=1 transcode block.
  const nominal = [64, 64, 1, 1];
  const clipped = [37, 29, 1];
  const ids = BigUint64Array.from(
    { length: 37 * 29 },
    (_, i) => BigInt(((i * 7919) % 11) + 1) * 0x100000001n,
  );
  const output = new TypedArrayBuilder(Uint32Array);
  encodeChannels(output, [16, 32, 1], ids, [...clipped, 1]);
  const compressed = output.view.slice();
  const uint64Source = boxSource({
    chunkDataSize: nominal,
    dataType: DataType.UINT64,
    blockSize: [16, 32, 1],
  });
  const full = decodeBaselineChunk(
    uint64Source,
    chunkWith(compressed, clipped),
  ) as BigUint64Array;

  const boxes: Record<string, ChunkVoxelBox> = {
    "inside the data": { x0: 3, y0: 4, z0: 0, x1: 30, y1: 27, z1: 0 },
    "across the clipped edge": { x0: 30, y0: 20, z0: 0, x1: 45, y1: 40, z1: 0 },
    "in the padding only": { x0: 50, y0: 50, z0: 0, x1: 63, y1: 63, z1: 0 },
  };

  for (const [label, box] of Object.entries(boxes)) {
    it(`compressed uint64 edge chunk, box ${label}: same values as the full decode`, () => {
      const read = readBaselineBox(
        uint64Source,
        chunkWith(compressed, clipped),
        box,
      );
      expect(read).toBeInstanceOf(BigUint64Array);
      expect(Array.from(read as BigUint64Array)).toEqual(
        cropBox(full, nominal, box),
      );
    });

    it(`raw uint8 edge chunk, box ${label}: same values as the full decode`, () => {
      const source = boxSource({
        chunkDataSize: nominal,
        dataType: DataType.UINT8,
      });
      const raw = Uint8Array.from({ length: 37 * 29 }, (_, i) => (i % 250) + 1);
      const fullRaw = decodeBaselineChunk(
        source,
        chunkWith(raw, clipped),
      ) as Uint8Array;
      const read = readBaselineBox(source, chunkWith(raw, clipped), box);
      expect(read).toBeInstanceOf(Uint8Array);
      expect(Array.from(read as Uint8Array)).toEqual(
        cropBox(fullRaw, nominal, box),
      );
    });
  }

  it("reads a sparse chunk as zeros of the box size", () => {
    const box = boxes["inside the data"];
    const read = readBaselineBox(uint64Source, chunkWith(null, clipped), box);
    expect(read).toBeInstanceOf(BigUint64Array);
    expect(read.length).toBe(28 * 24);
    expect(Array.from(read as BigUint64Array).every((v) => v === 0n)).toBe(
      true,
    );
  });
});

describe("NgChunkSource.readDatasourceBaselineBox (TM-373 PR 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the datasource render base of the box", async () => {
    const DATASOURCE = Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const chunkSource = makeChunkSourceResolving(
      fakeSource(SAVED.slice(), DATASOURCE),
    );
    // A saved copy must not shadow the datasource, as in the full read.
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    const read = await chunkSource.readDatasourceBaselineBox(
      LAYER,
      RES_8,
      CHUNK_ID,
      CHUNK_COORD,
      { x0: 1, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 },
    );

    // 2×2×2, x-fastest: x=1 of each (y, z) row.
    expect(Array.from(read.asView() as Uint32Array)).toEqual([2, 4, 6, 8]);
  });

  it("propagates ChunkReadFailedError after the same retries as the full read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fakeSource(SAVED.slice(), null);
    let attempts = 0;
    source.fetchChunk = async () => {
      attempts++;
      throw new Error("network down");
    };
    const chunkSource = makeChunkSourceResolving(source);

    await expect(
      chunkSource.readDatasourceBaselineBox(
        LAYER,
        RES_8,
        CHUNK_ID,
        CHUNK_COORD,
        { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 },
      ),
    ).rejects.toBeInstanceOf(ChunkReadFailedError);
    expect(attempts).toBe(3);
  });
});

describe("fetchBaselineWithRetry on compressed segmentation (TM-373 PR 6a)", () => {
  // A 64×64 uint64 edge chunk holding 37×29 of data, NG's z=1 transcode block.
  const nominal = [64, 64, 1, 1];
  const clipped = [37, 29, 1];
  const ids = BigUint64Array.from(
    { length: 37 * 29 },
    (_, i) => BigInt(((i * 104729) % 13) + 1) * 0x100000001n,
  );
  const output = new TypedArrayBuilder(Uint32Array);
  encodeChannels(output, [16, 32, 1], ids, [...clipped, 1]);
  const compressed = output.view.slice();

  /**
   * A source whose `chunk.data` is valid only inside the transform, like
   * NG's: right after it the block is overwritten.
   */
  function compressedSource(): VolumeChunkSource {
    const source = boxSource({
      chunkDataSize: nominal,
      dataType: DataType.UINT64,
      blockSize: [16, 32, 1],
    }) as unknown as {
      fetchChunk: (
        grid: Float32Array,
        transform: (chunk: unknown) => unknown,
      ) => Promise<unknown>;
    };
    source.fetchChunk = async (_grid, transform) => {
      const data = compressed.slice();
      const result = transform(chunkWith(data, clipped));
      data.fill(0xdeadbeef);
      return result;
    };
    return source as unknown as VolumeChunkSource;
  }

  it("gives the same padded baseline as the synchronous decode", async () => {
    const source = compressedSource();
    const expected = decodeBaselineChunk(
      source,
      chunkWith(compressed, clipped),
    );
    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);
    const view = result.asView();
    expect(view).toBeInstanceOf(BigUint64Array);
    expect(view.length).toBe(64 * 64);
    expect(Array.from(view as BigUint64Array)).toEqual(
      Array.from(expected as BigUint64Array),
    );
  });

  it("throws an abort when the signal aborts during the decode", async () => {
    const source = compressedSource();
    const controller = new AbortController();
    const pending = fetchBaselineWithRetry(
      source,
      COORD,
      GRID,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ChunkReadAbortedError);
  });
});
