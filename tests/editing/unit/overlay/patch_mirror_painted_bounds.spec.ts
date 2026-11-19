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
 * `LocalPatchChunk.paintedBounds` (TM-373, PR 6): a box holding every voxel
 * that has ever had `patched = 1`, grown from the mask itself — never from the
 * box of changed voxels, which a full mirror scan of a fresh chunk inflates to
 * almost the whole chunk (it copies baseline values into `data` everywhere).
 */

import { describe, expect, it } from "vitest";

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import { LocalPatchSource } from "#src/editing/local_patch_source.js";
import {
  fuseOverlayIntoChunk,
  fuseOverlayIntoChunkBox,
} from "#src/editing/overlay/patch_mirror.js";
import { vec3 } from "#src/util/geom.js";

const SIZE = [12, 10, 3] as const;
const VOLUME = SIZE[0] * SIZE[1] * SIZE[2];
const STROKE: ChunkVoxelBox = { x0: 2, y0: 3, z0: 1, x1: 5, y1: 4, z1: 1 };

const newChunk = () => new LocalPatchChunk(vec3.fromValues(...SIZE));

function voxelIndex(x: number, y: number, z: number): number {
  return (z * SIZE[1] + y) * SIZE[0] + x;
}

/** A non-zero baseline everywhere, so a fresh chunk's full scan writes all of `data`. */
function baseline(): BigUint64Array {
  return BigUint64Array.from({ length: VOLUME }, (_, i) => BigInt(i % 7) + 1n);
}

/** `base` with `box` painted with `value`. */
function painted(
  base: BigUint64Array,
  box: ChunkVoxelBox,
  value: bigint,
): BigUint64Array {
  const out = base.slice();
  for (let z = box.z0; z <= box.z1; z++) {
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) out[voxelIndex(x, y, z)] = value;
    }
  }
  return out;
}

function crop(full: BigUint64Array, box: ChunkVoxelBox): BigUint64Array {
  const out: bigint[] = [];
  for (let z = box.z0; z <= box.z1; z++) {
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++)
        out.push(full[voxelIndex(x, y, z)]);
    }
  }
  return BigUint64Array.from(out);
}

describe("LocalPatchChunk.paintedBounds", () => {
  it("starts empty", () => {
    expect(newChunk().paintedBounds).toBeNull();
  });

  it("grows with writeVoxel", () => {
    const chunk = newChunk();
    chunk.writeVoxel(4, 2, 0, 9n);
    chunk.writeVoxel(1, 7, 2, 0n); // erase-to-zero is patched too
    expect(chunk.paintedBounds).toEqual({
      x0: 1,
      y0: 2,
      z0: 0,
      x1: 4,
      y1: 7,
      z1: 2,
    });
  });

  it("is the whole chunk after writeFullChunk", () => {
    const source = new LocalPatchSource();
    source.writeFullChunk(
      [0, 0, 0],
      SIZE,
      new BigUint64Array(VOLUME),
      new Uint8Array(VOLUME),
    );
    expect(source.getChunk([0, 0, 0])!.paintedBounds).toEqual({
      x0: 0,
      y0: 0,
      z0: 0,
      x1: SIZE[0] - 1,
      y1: SIZE[1] - 1,
      z1: SIZE[2] - 1,
    });
  });
});

describe("fuse grows paintedBounds from the mask, not from the change box", () => {
  it("a fresh chunk's full scan: data changes everywhere, bounds = the stroke", () => {
    const chunk = newChunk();
    const base = baseline();
    const change = fuseOverlayIntoChunk(chunk, painted(base, STROKE, 0n), base);
    // The change box covers the whole chunk (baseline copied into `data`)…
    expect(change).toEqual({
      x0: 0,
      y0: 0,
      z0: 0,
      x1: SIZE[0] - 1,
      y1: SIZE[1] - 1,
      z1: SIZE[2] - 1,
    });
    // …the painted bounds only the stroke.
    expect(chunk.paintedBounds).toEqual(STROKE);
  });

  it("an undo (full scan back to the baseline) does not grow the bounds", () => {
    const chunk = newChunk();
    const base = baseline();
    fuseOverlayIntoChunk(chunk, painted(base, STROKE, 0n), base);
    fuseOverlayIntoChunk(chunk, base, base);
    expect(chunk.patched.every((bit) => bit === 0)).toBe(true);
    expect(chunk.paintedBounds).toEqual(STROKE);
  });

  it("a bounded pass grows the bounds by what it patched", () => {
    const chunk = newChunk();
    const base = baseline();
    fuseOverlayIntoChunk(chunk, painted(base, STROKE, 0n), base);
    const second: ChunkVoxelBox = { x0: 9, y0: 8, z0: 0, x1: 10, y1: 9, z1: 0 };
    const overlay = painted(painted(base, STROKE, 0n), second, 42n);
    fuseOverlayIntoChunkBox(chunk, overlay, crop(base, second), second);
    expect(chunk.paintedBounds).toEqual({
      x0: 2,
      y0: 3,
      z0: 0,
      x1: 10,
      y1: 9,
      z1: 1,
    });
  });

  it("every patched voxel lies inside the bounds", () => {
    const chunk = newChunk();
    const base = baseline();
    let overlay = base;
    const strokes: ChunkVoxelBox[] = [
      { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 0 },
      { x0: 7, y0: 2, z0: 2, x1: 11, y1: 5, z1: 2 },
      { x0: 3, y0: 9, z0: 1, x1: 3, y1: 9, z1: 1 },
    ];
    for (const [index, stroke] of strokes.entries()) {
      overlay = painted(overlay, stroke, BigInt(100 + index));
      fuseOverlayIntoChunk(chunk, overlay, base);
    }
    const bounds = chunk.paintedBounds!;
    for (let z = 0; z < SIZE[2]; z++) {
      for (let y = 0; y < SIZE[1]; y++) {
        for (let x = 0; x < SIZE[0]; x++) {
          if (chunk.patched[voxelIndex(x, y, z)] === 0) continue;
          expect(
            x >= bounds.x0 &&
              x <= bounds.x1 &&
              y >= bounds.y0 &&
              y <= bounds.y1 &&
              z >= bounds.z0 &&
              z <= bounds.z1,
          ).toBe(true);
        }
      }
    }
  });
});
