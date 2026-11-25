/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Edit } from "@zettaai/edit-session";
import {
  ChunkId,
  layerId,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import { takePaintedSubBox } from "#src/editing/overlay/painted_subbox_registry.js";
import {
  applyPaintBatch,
  libraryChunkHints,
} from "#src/editing/tool_runtimes/paint_batch_apply.js";
import type { PaintWriteBatch } from "#src/editing/tool_runtimes/paint_types.js";

const LAYER = layerId("seg");
const RES = ResolutionCtor.from([16, 16, 40]);

/** The portal copy: 1238×1065 chunks, offset not a multiple of the chunk. */
const PORTAL_GRID = {
  chunkDataSize: [1238, 1065, 1] as const,
  voxelOffset: [28943, 8913, 3404] as const,
};

const chunkIdOf = (x: number, y: number, z: number) =>
  ChunkId.fromCoord({ x, y, z });

describe("libraryChunkHints (TM-373)", () => {
  it("files the hint under the library's chunk, offset by voxelOffset", () => {
    // A brush stamp at voxel (29243, 9213, 3409): 300, 300 into the volume,
    // slice 5. On a grid anchored at 0 this is chunk (23, 8, 3409).
    const hints = libraryChunkHints(
      { origin: [29243, 9213, 3409], size: [33, 33, 1] },
      PORTAL_GRID,
    );
    expect(hints).toEqual([
      {
        chunkId: chunkIdOf(0, 0, 5),
        box: { x0: 300, y0: 300, z0: 0, x1: 332, y1: 332, z1: 0 },
      },
    ]);
  });

  it("splits a box across two library chunks into one hint each", () => {
    const grid = {
      chunkDataSize: [256, 256, 1] as const,
      voxelOffset: [100, 0, 0] as const,
    };
    // x 340..379 → offset-relative 240..279 → chunks 0 (240..255) and 1 (0..23).
    const hints = libraryChunkHints(
      { origin: [340, 10, 0], size: [40, 5, 1] },
      grid,
    );
    expect(hints).toEqual([
      {
        chunkId: chunkIdOf(0, 0, 0),
        box: { x0: 240, y0: 10, z0: 0, x1: 255, y1: 14, z1: 0 },
      },
      {
        chunkId: chunkIdOf(1, 0, 0),
        box: { x0: 0, y0: 10, z0: 0, x1: 23, y1: 14, z1: 0 },
      },
    ]);
  });

  it("matches the 0-anchored chunk when the offset is a multiple of the chunk", () => {
    const grid = {
      chunkDataSize: [64, 64, 64] as const,
      voxelOffset: [128, 0, 64] as const,
    };
    const hints = libraryChunkHints(
      { origin: [130, 5, 70], size: [4, 4, 4] },
      grid,
    );
    expect(hints).toEqual([
      {
        chunkId: chunkIdOf(0, 0, 0),
        box: { x0: 2, y0: 5, z0: 6, x1: 5, y1: 8, z1: 9 },
      },
    ]);
  });
});

describe("applyPaintBatch hints (TM-373)", () => {
  /**
   * A fake `Edit` whose `writeRegion` commits like the library: one
   * `chunk-changed` per library chunk, where the mirror takes the hint.
   */
  function recordingEdit(taken: Map<string, ChunkVoxelBox | undefined>): Edit {
    return {
      async writeRegion(
        _target: unknown,
        _values: unknown,
        box: {
          origin: readonly [number, number, number];
          size: readonly [number, number, number];
        },
      ) {
        for (const { chunkId } of libraryChunkHints(box, PORTAL_GRID)) {
          taken.set(chunkId, takePaintedSubBox(LAYER, RES, chunkId));
        }
      },
    } as unknown as Edit;
  }

  it("a stamp on the portal grid reaches the mirror with its box", async () => {
    // What `PaintingCompute` produces for that stamp: chunk coords on a grid
    // anchored at 0, sub-box local to that grid.
    const batch = {
      targetLayerId: LAYER,
      targetResolution: RES,
      chunks: [
        {
          chunkCoord: { x: 23, y: 8, z: 3409 },
          subregion: {
            origin: [29243 - 23 * 1238, 9213 - 8 * 1065, 0],
            size: [33, 33, 1],
          },
          values: new BigUint64Array(33 * 33),
        },
      ],
    } as unknown as PaintWriteBatch;
    const taken = new Map<string, ChunkVoxelBox | undefined>();

    await applyPaintBatch(recordingEdit(taken), batch, PORTAL_GRID);

    expect([...taken]).toEqual([
      [
        chunkIdOf(0, 0, 5),
        { x0: 300, y0: 300, z0: 0, x1: 332, y1: 332, z1: 0 },
      ],
    ]);
    // Nothing left behind for a later, non-paint commit.
    expect(takePaintedSubBox(LAYER, RES, chunkIdOf(0, 0, 5))).toBeUndefined();
    expect(
      takePaintedSubBox(LAYER, RES, chunkIdOf(23, 8, 3409)),
    ).toBeUndefined();
  });
});
