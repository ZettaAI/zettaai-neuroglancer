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
 * Consumer-owned paint apply path (TM-315 migration).
 *
 * Writes a `PaintWriteBatch` (produced by `PaintingCompute`) into the session
 * through an `Edit`. The library used to own this (`applyPaintBatch` +
 * `writeBlockIntoSlot`); now the consumer owns the tools, so it owns the apply.
 *
 * Each `PaintChunkWrite` is confined to a single chunk (chunk-local
 * `subregion`). We translate it to the chunk's GLOBAL voxel box and hand it to
 * `Edit.writeRegion`, which is the library's single region-clip enforcement
 * point: it clips the box to the session bounds, materializes only the covered
 * (and pinned) chunk via `beginWrite`, copies the dense block honoring the
 * optional `valueMask`, and commits the written subregion. A block that falls
 * entirely outside the session region is dropped before any `beginWrite` — the
 * same cross-boundary safety the old `writeBlockIntersectsBounds` provided.
 *
 * Does NOT record history — the caller (a stroke = one `Edit`) decides when to
 * `record()` / `discard()`.
 */

import type { Edit, ScaleMetadata, WriteTarget } from "@zettaai/edit-session";
import { ChunkId } from "@zettaai/edit-session";

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";

import {
  notePaintedSubBox,
  takePaintedSubBox,
} from "#src/editing/overlay/painted_subbox_registry.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import type { PaintWriteBatch } from "#src/editing/tool_runtimes/paint_types.js";

/** The target scale's chunk grid: what the library splits a write box by. */
export type PaintChunkGrid = Pick<
  ScaleMetadata,
  "chunkDataSize" | "voxelOffset"
>;

export async function applyPaintBatch(
  edit: Edit,
  batch: PaintWriteBatch,
  grid: PaintChunkGrid,
  // Polled before each chunk write. `writeRegion` awaits, so a stroke can be
  // canceled mid-batch, and `Edit` does not refuse writes after it is finalized:
  // a later chunk would land in the overlay with no undo entry behind it.
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const target: WriteTarget = {
    layerId: batch.targetLayerId,
    resolution: batch.targetResolution,
  };
  const [csx, csy, csz] = grid.chunkDataSize;
  const prof = paintProfiler.enabled;
  const t0 = prof ? performance.now() : 0;
  let appliedChunks = 0;

  for (const w of batch.chunks) {
    if (!isCurrent()) break;
    const [ox, oy, oz] = w.subregion.origin;
    const [sxv, syv, szv] = w.subregion.size;
    const box = {
      origin: [
        w.chunkCoord.x * csx + ox,
        w.chunkCoord.y * csy + oy,
        w.chunkCoord.z * csz + oz,
      ] as readonly [number, number, number],
      size: w.subregion.size,
    };
    // P2 (TM-317): record the chunk-local box this write is about to commit so
    // the GPU mirror (`PatchMirror`) can bound its fuse to the touched sub-box
    // instead of re-scanning the whole chunk. The `chunk-changed` handler
    // consumes this synchronously DURING `writeRegion` (the emit is synchronous
    // from `commitWrites`); if the write is skipped (clipped to bounds / fully
    // masked → no event), we drop the orphaned hint right after. Empty sub-boxes
    // never produce a write — skip them.
    const hints =
      sxv > 0 && syv > 0 && szv > 0 ? libraryChunkHints(box, grid) : [];
    for (const hint of hints) {
      notePaintedSubBox(
        target.layerId,
        target.resolution,
        hint.chunkId,
        hint.box,
      );
    }
    await edit.writeRegion(
      target,
      w.values,
      box,
      w.valueMask !== undefined ? { valueMask: w.valueMask } : undefined,
    );
    // Drop any hint the synchronous commit handler did not consume (the write
    // was skipped), so a stale hint can never bound a later non-paint commit.
    for (const hint of hints) {
      takePaintedSubBox(target.layerId, target.resolution, hint.chunkId);
    }
    appliedChunks++;
  }

  if (prof) {
    paintProfiler.record(
      "overlay.paint.apply.writeRegion",
      performance.now() - t0,
    );
    paintProfiler.count("overlay.paint.apply.chunks", appliedChunks);
  }
}

/** A sub-box hint for one chunk of the library's grid. */
interface LibraryChunkHint {
  readonly chunkId: ChunkId;
  readonly box: ChunkVoxelBox;
}

/**
 * The hints for a global write box, one per chunk of the LIBRARY's grid it
 * overlaps, in that chunk's local coordinates (TM-373).
 *
 * The library splits the box by chunks anchored at the scale's `voxelOffset`
 * (`chunksOverlappingBox`) and fires `chunk-changed` with those chunk ids.
 * The batch's own `chunkCoord` is on a grid anchored at 0, which matches only
 * when the offset is a multiple of the chunk size. On the portal data (offset
 * 28943, 8913, 3404) it did not: every such hint was filed under a chunk that
 * never commits, and the mirror scanned the whole chunk instead.
 */
export function libraryChunkHints(
  box: {
    readonly origin: readonly [number, number, number];
    readonly size: readonly [number, number, number];
  },
  grid: PaintChunkGrid,
): LibraryChunkHint[] {
  const axisRanges = [0, 1, 2].map((axis) => {
    const size = grid.chunkDataSize[axis];
    const first = box.origin[axis] - grid.voxelOffset[axis];
    const last = first + box.size[axis] - 1;
    return {
      size,
      first,
      last,
      firstChunk: Math.floor(first / size),
      lastChunk: Math.floor(last / size),
    };
  });
  const [rangeX, rangeY, rangeZ] = axisRanges;
  const localSpan = (
    range: (typeof axisRanges)[number],
    chunk: number,
  ): [number, number] => [
    Math.max(range.first, chunk * range.size) - chunk * range.size,
    Math.min(range.last, (chunk + 1) * range.size - 1) - chunk * range.size,
  ];
  const hints: LibraryChunkHint[] = [];
  for (let z = rangeZ.firstChunk; z <= rangeZ.lastChunk; z++) {
    for (let y = rangeY.firstChunk; y <= rangeY.lastChunk; y++) {
      for (let x = rangeX.firstChunk; x <= rangeX.lastChunk; x++) {
        const [x0, x1] = localSpan(rangeX, x);
        const [y0, y1] = localSpan(rangeY, y);
        const [z0, z1] = localSpan(rangeZ, z);
        hints.push({
          chunkId: ChunkId.fromCoord({ x, y, z }),
          box: { x0, y0, z0, x1, y1, z1 },
        });
      }
    }
  }
  return hints;
}
