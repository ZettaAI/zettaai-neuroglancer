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

import { editChunkDataSize } from "#src/editing/adapters/edit_chunk_extent.js";

function spec(
  chunk: [number, number, number],
  upper: [number, number, number],
  lower: [number, number, number] = [0, 0, 0],
) {
  return {
    chunkDataSize: [...chunk, 1],
    lowerVoxelBound: [...lower, 0],
    upperVoxelBound: [...upper, 1],
  };
}

describe("editChunkDataSize", () => {
  it("uses the volume's extent on every axis it fills with one chunk", () => {
    // The portal test dataset: 1238×1065×11 in 4096×4096×1 chunks.
    expect(editChunkDataSize(spec([4096, 4096, 1], [1238, 1065, 11]))).toEqual([
      1238, 1065, 1,
    ]);
  });

  it("keeps the nominal size on an axis with more than one chunk", () => {
    expect(editChunkDataSize(spec([256, 256, 1], [1238, 1065, 11]))).toEqual([
      256, 256, 1,
    ]);
  });

  it("decides each axis on its own", () => {
    expect(editChunkDataSize(spec([4096, 512, 16], [1238, 1065, 8]))).toEqual([
      1238, 512, 8,
    ]);
  });

  it("keeps the nominal size when the volume is exactly one chunk", () => {
    expect(editChunkDataSize(spec([4096, 4096, 1], [4096, 4096, 1]))).toEqual([
      4096, 4096, 1,
    ]);
  });

  it("keeps the nominal size when the data does not start at chunk 0", () => {
    expect(
      editChunkDataSize(spec([4096, 4096, 1], [1238, 1065, 1], [10, 0, 0])),
    ).toEqual([4096, 1065, 1]);
  });

  it("keeps the nominal size when the bounds are unknown", () => {
    expect(editChunkDataSize({ chunkDataSize: [4096, 4096, 1, 1] })).toEqual([
      4096, 4096, 1,
    ]);
  });
});
