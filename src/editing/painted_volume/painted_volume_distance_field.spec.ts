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

import { PaintedVolumeDistanceField } from "#src/editing/painted_volume/painted_volume_distance_field.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import { referenceEncodedDistances } from "#tests/editing/harness/painted_volume_distance_reference.js";

type Triple = readonly [number, number, number];

/** Deterministic pseudo-random bits, so a failure reproduces. */
function seededBits(seed: number, count: number, density: number): boolean[] {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 < density;
  });
}

/** Reference bytes of every texel of `box`, from the whole volume's classes. */
function referenceBytes(
  occupied: readonly boolean[],
  size: Triple,
  box: TexelBox,
): number[] {
  const [sizeX, sizeY] = size;
  const bytes: number[] = [];
  for (let z = box.z0; z <= box.z1; ++z) {
    const slice = occupied.slice(z * sizeX * sizeY, (z + 1) * sizeX * sizeY);
    const encoded = referenceEncodedDistances(slice, sizeX, sizeY);
    for (let y = box.y0; y <= box.y1; ++y) {
      for (let x = box.x0; x <= box.x1; ++x) {
        bytes.push(Math.round(encoded[y * sizeX + x] * 255));
      }
    }
  }
  return bytes;
}

function wholeBox(size: Triple): TexelBox {
  return {
    x0: 0,
    y0: 0,
    z0: 0,
    x1: size[0] - 1,
    y1: size[1] - 1,
    z1: size[2] - 1,
  };
}

function classesOf(occupied: readonly boolean[]): Uint8Array {
  return Uint8Array.from(occupied, (isOccupied) => (isOccupied ? 7 : 0));
}

describe("PaintedVolumeDistanceField", () => {
  it.each([0.1, 0.5, 0.9])(
    "matches the reference on a random volume of density %s",
    (density) => {
      const size: Triple = [37, 23, 3];
      const occupied = seededBits(
        Math.round(density * 1000),
        size[0] * size[1] * size[2],
        density,
      );
      const field = new PaintedVolumeDistanceField(size);
      const box = wholeBox(size);
      field.writeClasses(box, classesOf(occupied));
      const distances = field.distancesAround(box);
      expect(distances.texelBox).toEqual(box);
      expect(Array.from(distances.bytes)).toEqual(
        referenceBytes(occupied, size, box),
      );
    },
  );

  it("recomputes the box grown by the range, from what was written before", () => {
    const size: Triple = [30, 20, 2];
    const occupied = seededBits(42, size[0] * size[1] * size[2], 0.4);
    const field = new PaintedVolumeDistanceField(size);
    field.writeClasses(wholeBox(size), classesOf(occupied));

    // Rewrite a small box on slice 1 only.
    const written: TexelBox = { x0: 10, y0: 6, z0: 1, x1: 13, y1: 8, z1: 1 };
    const rewrite: number[] = [];
    for (let y = written.y0; y <= written.y1; ++y) {
      for (let x = written.x0; x <= written.x1; ++x) {
        const index = (size[1] + y) * size[0] + x;
        occupied[index] = !occupied[index];
        rewrite.push(occupied[index] ? 3 : 0);
      }
    }
    field.writeClasses(written, Uint8Array.from(rewrite));
    const distances = field.distancesAround(written);

    expect(distances.texelBox).toEqual({
      x0: 6,
      y0: 2,
      z0: 1,
      x1: 17,
      y1: 12,
      z1: 1,
    });
    expect(Array.from(distances.bytes)).toEqual(
      referenceBytes(occupied, size, distances.texelBox),
    );
  });

  it("clamps the grown box to the texture", () => {
    const size: Triple = [8, 6, 1];
    const field = new PaintedVolumeDistanceField(size);
    const corner: TexelBox = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 0 };
    field.writeClasses(corner, Uint8Array.of(1, 1, 1, 1));
    expect(field.distancesAround(corner).texelBox).toEqual({
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 5,
      y1: 5,
      z1: 0,
    });
  });

  it("forgets every class on clear", () => {
    const size: Triple = [6, 6, 1];
    const field = new PaintedVolumeDistanceField(size);
    const box = wholeBox(size);
    field.writeClasses(box, new Uint8Array(36).fill(1));
    field.clear();
    expect(Array.from(field.distancesAround(box).bytes)).toEqual(
      referenceBytes(new Array(36).fill(false), size, box),
    );
  });
});
