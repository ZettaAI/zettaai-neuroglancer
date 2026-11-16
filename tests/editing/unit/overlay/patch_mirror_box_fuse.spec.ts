/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import {
  fuseOverlayIntoChunk,
  fuseOverlayIntoChunkBox,
} from "#src/editing/overlay/patch_mirror.js";
import { vec3 } from "#src/util/geom.js";

const SIZE = [12, 10, 3] as const;
const VOLUME = SIZE[0] * SIZE[1] * SIZE[2];

function voxelIndex(x: number, y: number, z: number): number {
  return (z * SIZE[1] + y) * SIZE[0] + x;
}

/** Deterministic values from a small alphabet, so some voxels match. */
function values(seed: number): number[] {
  let state = seed;
  return Array.from({ length: VOLUME }, () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return (state >>> 8) % 4;
  });
}

function cropBox<T>(full: ArrayLike<T>, box: ChunkVoxelBox): T[] {
  const out: T[] = [];
  for (let z = box.z0; z <= box.z1; z++) {
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++)
        out.push(full[voxelIndex(x, y, z)]);
    }
  }
  return out;
}

const newChunk = () => new LocalPatchChunk(vec3.fromValues(...SIZE));

const BOX: ChunkVoxelBox = { x0: 2, y0: 3, z0: 1, x1: 9, y1: 8, z1: 2 };

interface Kind {
  readonly label: string;
  readonly overlay: (seed: number) => ArrayBufferView & { length: number };
  readonly cropped: (
    full: ArrayBufferView & { length: number },
    box: ChunkVoxelBox,
  ) => ArrayBufferView & { length: number };
}

const KINDS: readonly Kind[] = [
  {
    label: "uint64",
    overlay: (seed) =>
      BigUint64Array.from(values(seed), (v) => BigInt(v) * 0x100000001n),
    cropped: (full, box) =>
      BigUint64Array.from(cropBox(full as BigUint64Array, box)),
  },
  {
    label: "uint16",
    overlay: (seed) => Uint16Array.from(values(seed), (v) => v * 1000),
    cropped: (full, box) => Uint16Array.from(cropBox(full as Uint16Array, box)),
  },
];

describe("fuseOverlayIntoChunkBox", () => {
  for (const { label, overlay: makeValues, cropped } of KINDS) {
    it(`${label}: same data, patched and change box as the full-baseline fuse`, () => {
      const overlay = makeValues(1);
      const baseline = makeValues(2);
      const full = newChunk();
      const boxed = newChunk();

      const fullBox = fuseOverlayIntoChunk(full, overlay, baseline, BOX);
      const boxedBox = fuseOverlayIntoChunkBox(
        boxed,
        overlay,
        cropped(baseline, BOX),
        BOX,
      );

      expect(boxedBox).toEqual(fullBox);
      expect(boxedBox).not.toBeNull();
      expect(boxed.data).toEqual(full.data);
      expect(boxed.patched).toEqual(full.patched);
    });

    it(`${label}: a second pass over the same box agrees too`, () => {
      const baseline = makeValues(2);
      const full = newChunk();
      const boxed = newChunk();
      fuseOverlayIntoChunk(full, makeValues(1), baseline, BOX);
      fuseOverlayIntoChunkBox(
        boxed,
        makeValues(1),
        cropped(baseline, BOX),
        BOX,
      );

      const next = makeValues(3);
      const fullBox = fuseOverlayIntoChunk(full, next, baseline, BOX);
      const boxedBox = fuseOverlayIntoChunkBox(
        boxed,
        next,
        cropped(baseline, BOX),
        BOX,
      );

      expect(boxedBox).toEqual(fullBox);
      expect(boxed.data).toEqual(full.data);
      expect(boxed.patched).toEqual(full.patched);
    });
  }

  it("a one-voxel box at the far corner", () => {
    const corner: ChunkVoxelBox = {
      x0: SIZE[0] - 1,
      y0: SIZE[1] - 1,
      z0: SIZE[2] - 1,
      x1: SIZE[0] - 1,
      y1: SIZE[1] - 1,
      z1: SIZE[2] - 1,
    };
    const overlay = new Uint16Array(VOLUME);
    overlay[VOLUME - 1] = 7;
    const chunk = newChunk();
    expect(
      fuseOverlayIntoChunkBox(chunk, overlay, new Uint16Array(1), corner),
    ).toEqual(corner);
    expect(chunk.data[VOLUME - 1]).toBe(7n);
    expect(chunk.patched[VOLUME - 1]).toBe(1);
  });

  it("returns null when nothing in the box changed", () => {
    const overlay = new Uint16Array(VOLUME);
    expect(
      fuseOverlayIntoChunkBox(
        newChunk(),
        overlay,
        new Uint16Array(8 * 6 * 2),
        BOX,
      ),
    ).toBeNull();
  });

  it("refuses a baseline that is not the box's size", () => {
    expect(() =>
      fuseOverlayIntoChunkBox(
        newChunk(),
        new Uint16Array(VOLUME),
        new Uint16Array(5),
        BOX,
      ),
    ).toThrow(/baseline length 5 != box volume 96/);
  });

  it("refuses a box outside the chunk", () => {
    expect(() =>
      fuseOverlayIntoChunkBox(
        newChunk(),
        new Uint16Array(VOLUME),
        new Uint16Array(1),
        { x0: 12, y0: 0, z0: 0, x1: 12, y1: 0, z1: 0 },
      ),
    ).toThrow(/not inside the chunk/);
  });
});
