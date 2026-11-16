/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * What one baseline chunk costs per operation, by chunk size (TM-373, PR 0).
 *
 * Each operation here runs once per brush move, per stroke end or per first
 * touch of a chunk (see `Zetta/PAINT_LARGE_CHUNKS_PERF_PLAN.md` §1), so its
 * cost scales with the chunk, not the stroke. Sizes:
 *  - 256²×1: the "fast" control;
 *  - 4096²×1 interior: a full chunk;
 *  - 4096²×1 edge: the portal test dataset, 1238×1065 of data padded to 4096²
 *    (TM-353) — decode is clipped, everything after it is nominal.
 *
 * The compressed-segmentation block is what NG picks when it transcodes raw
 * uint64 with a z=1 chunk (`getNearIsotropicBlockSize`, ≤ 512 voxels).
 *
 * Run: npx vitest bench --run src/editing/adapters/baseline_chunk_costs.benchmark.ts
 */

import type { ChunkVoxelBuffer } from "@zettaai/edit-session";
import { contentRefFromBuffer, fnv1aHash64 } from "@zettaai/edit-session";
import { bench, describe } from "vitest";

import type { Chunk } from "#src/chunk_manager/frontend.js";
import { contentRefWithDeferredHash } from "#src/editing/adapters/deferred_content_hash.js";
import {
  decodeBaselineChunk,
  readBaselineBox,
} from "#src/editing/adapters/ng_chunk_source.js";
import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import {
  fuseOverlayIntoChunk,
  fuseOverlayIntoChunkBox,
} from "#src/editing/overlay/patch_mirror.js";
import { encodeChannels } from "#src/sliceview/compressed_segmentation/encode_uint64.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { TypedArrayBuilder } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import { vec3 } from "#src/util/geom.js";

/** NG's transcode block for a z=1 chunk. */
const TRANSCODE_BLOCK_SIZE = [16, 32, 1];

/** Few runs: one 4096² operation takes tens to hundreds of ms. */
const BENCH_OPTIONS = { iterations: 5, warmupIterations: 1, time: 0 };

interface ChunkCase {
  readonly label: string;
  /** The chunk size NG and the edit library index with. */
  readonly nominal: readonly [number, number, number];
  /** The data actually in the chunk (smaller at the volume edge). */
  readonly clipped: readonly [number, number, number];
}

const CASES: readonly ChunkCase[] = [
  { label: "256²", nominal: [256, 256, 1], clipped: [256, 256, 1] },
  {
    label: "4096² interior",
    nominal: [4096, 4096, 1],
    clipped: [4096, 4096, 1],
  },
  {
    label: "4096² edge (1238×1065 of data)",
    nominal: [4096, 4096, 1],
    clipped: [1238, 1065, 1],
  },
];

/** A square box of `side` voxels at the chunk's low corner, inside the data. */
function cornerBox(side: number, clipped: readonly number[]): ChunkVoxelBox {
  const sideX = Math.min(side, clipped[0]);
  const sideY = Math.min(side, clipped[1]);
  return { x0: 0, y0: 0, z0: 0, x1: sideX - 1, y1: sideY - 1, z1: 0 };
}

/** Brush box: radius 16 → 33×33 (PR 0's strokes). */
const BRUSH_BOX_SIDE = 33;

function voxelCount(size: readonly [number, number, number]): number {
  return size[0] * size[1] * size[2];
}

/** The fixture generator's segment ids: blocky 32-voxel ids 1..7. */
function segmentIds(size: readonly [number, number, number]): BigUint64Array {
  const [sizeX, sizeY] = size;
  const ids = new BigUint64Array(voxelCount(size));
  for (let y = 0; y < sizeY; y++) {
    for (let x = 0; x < sizeX; x++) {
      ids[y * sizeX + x] = BigInt((((x >> 5) + (y >> 5)) % 7) + 1);
    }
  }
  return ids;
}

function uint8Ids(size: readonly [number, number, number]): Uint8Array {
  return Uint8Array.from(segmentIds(size), (id) => Number(id));
}

function compressedSegmentation(
  ids: BigUint64Array,
  size: readonly [number, number, number],
): Uint32Array {
  const output = new TypedArrayBuilder(Uint32Array);
  encodeChannels(output, TRANSCODE_BLOCK_SIZE, ids, [...size, 1]);
  return output.view.slice();
}

/** The two fields of a frontend chunk `decodeBaselineChunk` reads. */
function fakeChunk(
  data: ChunkVoxelBuffer | Uint32Array,
  clipped: readonly [number, number, number],
): Chunk {
  return { data, chunkDataSize: [...clipped, 1] } as unknown as Chunk;
}

/** The spec fields `decodeBaselineChunk` reads. */
function fakeSource(
  nominal: readonly [number, number, number],
  dataType: DataType,
  compressed: boolean,
): VolumeChunkSource {
  return {
    spec: {
      chunkDataSize: [...nominal, 1],
      dataType,
      compressedSegmentationBlockSize: compressed
        ? Uint32Array.from(TRANSCODE_BLOCK_SIZE)
        : undefined,
    },
  } as unknown as VolumeChunkSource;
}

for (const chunkCase of CASES) {
  const { label, nominal, clipped } = chunkCase;
  const clippedIds = segmentIds(clipped);
  const encoded = compressedSegmentation(clippedIds, clipped);
  const uint64Source = fakeSource(nominal, DataType.UINT64, true);
  const uint8Source = fakeSource(nominal, DataType.UINT8, false);
  const uint8Chunk = fakeChunk(uint8Ids(clipped), clipped);
  const baseline = decodeBaselineChunk(
    uint64Source,
    fakeChunk(encoded, clipped),
  ) as BigUint64Array;
  const overlay = baseline.slice();
  for (let i = 0; i < overlay.length; i += 97) overlay[i] = 1000n;
  const patchChunk = new LocalPatchChunk(vec3.fromValues(...nominal));

  describe(`baseline chunk ${label}`, () => {
    bench(
      "decodeBaselineChunk uint64 (cseg decode + pad) — every brush move",
      () => {
        decodeBaselineChunk(uint64Source, fakeChunk(encoded, clipped));
      },
      BENCH_OPTIONS,
    );
    bench(
      "decodeBaselineChunk uint8 (clone + pad) — every brush move",
      () => {
        decodeBaselineChunk(uint8Source, uint8Chunk);
      },
      BENCH_OPTIONS,
    );
    // TM-373 PR 2: a bounded mirror pass reads its box only.
    const boxLabels = new Set<string>();
    for (const side of [BRUSH_BOX_SIDE, 512, 4096]) {
      const box = cornerBox(side, clipped);
      const boxLabel = `${box.x1 + 1}×${box.y1 + 1}`;
      // On a small chunk the larger sides clamp to the same box.
      if (boxLabels.has(boxLabel)) continue;
      boxLabels.add(boxLabel);
      bench(
        `readBaselineBox uint64 ${boxLabel} (cseg box read) — every brush move, PR 2`,
        () => {
          readBaselineBox(uint64Source, fakeChunk(encoded, clipped), box);
        },
        BENCH_OPTIONS,
      );
    }
    const brushBox = cornerBox(BRUSH_BOX_SIDE, clipped);
    const brushBaseline = readBaselineBox(
      uint64Source,
      fakeChunk(encoded, clipped),
      brushBox,
    ) as BigUint64Array;
    bench(
      "readBaselineBox uint8 33×33 (row copy) — every brush move, PR 2",
      () => {
        readBaselineBox(uint8Source, uint8Chunk, brushBox);
      },
      BENCH_OPTIONS,
    );
    bench(
      "fuseOverlayIntoChunkBox 33×33 — a bounded mirror pass, PR 2",
      () => {
        fuseOverlayIntoChunkBox(patchChunk, overlay, brushBaseline, brushBox);
      },
      BENCH_OPTIONS,
    );
    bench(
      "new BigUint64Array(nominal)",
      () => {
        new BigUint64Array(voxelCount(nominal));
      },
      BENCH_OPTIONS,
    );
    bench(
      "slice() — one chunk copy",
      () => {
        baseline.slice();
      },
      BENCH_OPTIONS,
    );
    bench(
      "fnv1aHash64 — content hash",
      () => {
        fnv1aHash64(new Uint8Array(baseline.buffer));
      },
      BENCH_OPTIONS,
    );
    bench(
      "contentRefFromBuffer (copy + hash) — library first touch",
      () => {
        contentRefFromBuffer(baseline);
      },
      BENCH_OPTIONS,
    );
    bench(
      "contentRefWithDeferredHash (copy) — stroke before/after image, PR 4",
      () => {
        contentRefWithDeferredHash(baseline);
      },
      BENCH_OPTIONS,
    );
    bench(
      "fuseOverlayIntoChunk, whole chunk — a full mirror pass",
      () => {
        fuseOverlayIntoChunk(patchChunk, overlay, baseline);
      },
      BENCH_OPTIONS,
    );
  });
}
