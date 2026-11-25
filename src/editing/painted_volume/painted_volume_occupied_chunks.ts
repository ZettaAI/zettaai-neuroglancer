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
 * @file Which chunks of the painted-volume texture hold a shown segment.
 *
 * The render layer clips its proxy cube to `occupiedBox`, the union of those
 * chunks' texel boxes — chunk precision, so a stroke never has to rescan the
 * texture to shrink the box (plan §7.5).
 */

import type { ChunkKey } from "#src/editing/local_patch_source.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";

export class PaintedVolumeOccupiedChunks {
  private readonly texelBoxByKey = new Map<ChunkKey, TexelBox>();
  private union: TexelBox | undefined;
  private unionStale = false;

  /** Inclusive texel box of every occupied chunk; `undefined` when none is. */
  get occupiedBox(): TexelBox | undefined {
    if (this.unionStale) {
      this.union = unionOf(this.texelBoxByKey.values());
      this.unionStale = false;
    }
    return this.union;
  }

  /**
   * Record whether the chunk `key`, covering `chunkTexelBox`, holds a shown
   * voxel. Returns `true` when the occupied set changed.
   */
  mark(key: ChunkKey, chunkTexelBox: TexelBox, occupied: boolean): boolean {
    const wasOccupied = this.texelBoxByKey.has(key);
    if (occupied === wasOccupied) return false;
    if (occupied) {
      this.texelBoxByKey.set(key, chunkTexelBox);
    } else {
      this.texelBoxByKey.delete(key);
    }
    this.unionStale = true;
    return true;
  }

  clear(): void {
    this.texelBoxByKey.clear();
    this.union = undefined;
    this.unionStale = false;
  }
}

function unionOf(boxes: Iterable<TexelBox>): TexelBox | undefined {
  let union: TexelBox | undefined;
  for (const box of boxes) {
    if (union === undefined) {
      union = { ...box };
      continue;
    }
    union.x0 = Math.min(union.x0, box.x0);
    union.y0 = Math.min(union.y0, box.y0);
    union.z0 = Math.min(union.z0, box.z0);
    union.x1 = Math.max(union.x1, box.x1);
    union.y1 = Math.max(union.y1, box.y1);
    union.z1 = Math.max(union.z1, box.z1);
  }
  return union;
}
