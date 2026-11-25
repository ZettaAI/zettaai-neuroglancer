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
 * @file Patch changes the painted-volume preview has not drawn yet.
 *
 * `LocalPatchStore.chunkChanged` fires on the painting hot path, so the preview
 * only records the changed box here and does the work on its own frame. Boxes
 * of one chunk are unioned; a whole-chunk change absorbs them. Draining is
 * bounded by a voxel budget so a large fill spreads over several frames.
 */

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import type { ChunkKey } from "#src/editing/local_patch_source.js";

type Triple = readonly [number, number, number];

/** One chunk's changed voxels, resolved to an explicit chunk-local box. */
export interface PendingChunkChange {
  readonly key: ChunkKey;
  readonly box: ChunkVoxelBox;
}

export function wholeChunkBox(chunkSize: Triple): ChunkVoxelBox {
  return {
    x0: 0,
    y0: 0,
    z0: 0,
    x1: chunkSize[0] - 1,
    y1: chunkSize[1] - 1,
    z1: chunkSize[2] - 1,
  };
}

export function isWholeChunkBox(
  box: ChunkVoxelBox,
  chunkSize: Triple,
): boolean {
  return (
    box.x0 === 0 &&
    box.y0 === 0 &&
    box.z0 === 0 &&
    box.x1 === chunkSize[0] - 1 &&
    box.y1 === chunkSize[1] - 1 &&
    box.z1 === chunkSize[2] - 1
  );
}

export class PaintedVolumePendingChanges {
  /** `null` = the whole chunk. Map order is arrival order. */
  private readonly boxByKey = new Map<ChunkKey, ChunkVoxelBox | null>();

  get size(): number {
    return this.boxByKey.size;
  }

  note(key: ChunkKey, box: ChunkVoxelBox | null): void {
    const existing = this.boxByKey.get(key);
    if (existing === null) return;
    if (box === null) {
      this.boxByKey.set(key, null);
    } else if (existing === undefined) {
      this.boxByKey.set(key, { ...box });
    } else {
      unionInto(existing, box);
    }
  }

  delete(key: ChunkKey): void {
    this.boxByKey.delete(key);
  }

  clear(): void {
    this.boxByKey.clear();
  }

  /**
   * Remove and return changes in arrival order until their voxel count reaches
   * `voxelBudget`. At least one change is returned when any is pending, so a
   * chunk larger than the budget still makes progress.
   */
  drain(voxelBudget: number, chunkSize: Triple): PendingChunkChange[] {
    const drained: PendingChunkChange[] = [];
    let spentVoxels = 0;
    for (const [key, pendingBox] of this.boxByKey) {
      if (drained.length > 0 && spentVoxels >= voxelBudget) break;
      const box = pendingBox ?? wholeChunkBox(chunkSize);
      drained.push({ key, box });
      spentVoxels += voxelCountOf(box);
    }
    for (const change of drained) this.boxByKey.delete(change.key);
    return drained;
  }
}

export function voxelCountOf(box: ChunkVoxelBox): number {
  return (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) * (box.z1 - box.z0 + 1);
}

function unionInto(target: ChunkVoxelBox, box: ChunkVoxelBox): void {
  target.x0 = Math.min(target.x0, box.x0);
  target.y0 = Math.min(target.y0, box.y0);
  target.z0 = Math.min(target.z0, box.z0);
  target.x1 = Math.max(target.x1, box.x1);
  target.y1 = Math.max(target.y1, box.y1);
  target.z1 = Math.max(target.z1, box.z1);
}
