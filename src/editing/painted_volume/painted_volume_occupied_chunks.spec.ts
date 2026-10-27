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

import { PaintedVolumeOccupiedChunks } from "#src/editing/painted_volume/painted_volume_occupied_chunks.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";

type Triple = readonly [number, number, number];

function texelBoxOf(lo: Triple, hi: Triple): TexelBox {
  return { x0: lo[0], y0: lo[1], z0: lo[2], x1: hi[0], y1: hi[1], z1: hi[2] };
}

const FIRST = texelBoxOf([0, 0, 0], [3, 3, 1]);
const SECOND = texelBoxOf([8, 4, 2], [11, 7, 3]);

describe("PaintedVolumeOccupiedChunks", () => {
  it("has no occupied box while empty", () => {
    expect(new PaintedVolumeOccupiedChunks().occupiedBox).toBeUndefined();
  });

  it("unions the texel boxes of every occupied chunk", () => {
    const occupied = new PaintedVolumeOccupiedChunks();
    expect(occupied.mark("a", FIRST, true)).toBe(true);
    expect(occupied.mark("b", SECOND, true)).toBe(true);
    expect(occupied.occupiedBox).toEqual(texelBoxOf([0, 0, 0], [11, 7, 3]));
  });

  it("shrinks when a chunk empties and reports the change", () => {
    const occupied = new PaintedVolumeOccupiedChunks();
    occupied.mark("a", FIRST, true);
    occupied.mark("b", SECOND, true);
    expect(occupied.mark("b", SECOND, false)).toBe(true);
    expect(occupied.occupiedBox).toEqual(FIRST);
    expect(occupied.mark("a", FIRST, false)).toBe(true);
    expect(occupied.occupiedBox).toBeUndefined();
  });

  it("reports no change when a chunk keeps its state", () => {
    const occupied = new PaintedVolumeOccupiedChunks();
    occupied.mark("a", FIRST, true);
    expect(occupied.mark("a", FIRST, true)).toBe(false);
    expect(occupied.mark("b", SECOND, false)).toBe(false);
  });

  it("forgets every chunk on clear", () => {
    const occupied = new PaintedVolumeOccupiedChunks();
    occupied.mark("a", FIRST, true);
    occupied.clear();
    expect(occupied.occupiedBox).toBeUndefined();
  });
});
