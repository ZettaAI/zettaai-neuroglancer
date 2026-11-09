/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  LayerMetadata,
  Resolution,
  VoxelDataType,
} from "@zettaai/edit-session";
import {
  DEFAULT_HISTORY_POLICY,
  layerId,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import {
  bytesPerChunk,
  editHistoryPolicy,
  historyBudgetBytes,
  maxFillHistoryBytes,
} from "#src/editing/edit_history_budget.js";

const MiB = 1024 * 1024;
const FINE: Resolution = ResolutionCtor.from([8, 8, 40]);
const COARSE: Resolution = ResolutionCtor.from([16, 16, 40]);

function layer(
  voxelDataType: VoxelDataType,
  chunks: ReadonlyMap<Resolution, readonly [number, number, number]>,
  channels = 1,
): LayerMetadata {
  return {
    layerId: layerId(`layer-${voxelDataType}`),
    voxelDataType,
    channels,
    scales: [...chunks].map(([resolution, chunkDataSize]) => ({
      resolution,
      voxelSizeNm: [8, 8, 40],
      voxelOffset: [0, 0, 0],
      sizeVoxels: [8192, 8192, 2],
      chunkDataSize,
    })),
  };
}

const uint64Of = (chunk: readonly [number, number, number]) =>
  layer("uint64", new Map([[FINE, chunk]]));

describe("bytesPerChunk", () => {
  it("is voxels × bytes per voxel × channels", () => {
    expect(bytesPerChunk(uint64Of([4096, 4096, 1]), FINE)).toBe(128 * MiB);
    const rgb = layer("uint8", new Map([[FINE, [64, 64, 64]]]), 3);
    expect(bytesPerChunk(rgb, FINE)).toBe(64 * 64 * 64 * 3);
  });
});

describe("historyBudgetBytes", () => {
  it("keeps the library default for small chunks", () => {
    expect(
      historyBudgetBytes([
        { metadata: uint64Of([256, 256, 1]), resolutions: [FINE] },
      ]),
    ).toBe(DEFAULT_HISTORY_POLICY.maxContentBytes);
    // The portal test data after TM-373 PR 9a: 1238×1065 per slice, 10 MB.
    expect(
      historyBudgetBytes([
        { metadata: uint64Of([1238, 1065, 1]), resolutions: [FINE] },
      ]),
    ).toBe(256 * MiB);
  });

  it("holds four of the largest chunks: 512 MB on 4096² uint64", () => {
    expect(
      historyBudgetBytes([
        { metadata: uint64Of([4096, 4096, 1]), resolutions: [FINE] },
      ]),
    ).toBe(512 * MiB);
  });

  it("stops at 768 MB", () => {
    expect(
      historyBudgetBytes([
        { metadata: uint64Of([8192, 8192, 1]), resolutions: [FINE] },
      ]),
    ).toBe(768 * MiB);
  });

  it("takes the largest chunk over every layer and opened resolution", () => {
    const pyramid = layer(
      "uint8",
      new Map([
        [FINE, [256, 256, 1]],
        [COARSE, [4096, 4096, 1]],
      ]),
    );
    // uint8 4096²: 16 MB × 4 = 64 MB, so a uint64 256² layer alone decides.
    expect(
      historyBudgetBytes([
        { metadata: pyramid, resolutions: [FINE, COARSE] },
        { metadata: uint64Of([4096, 4096, 1]), resolutions: [FINE] },
      ]),
    ).toBe(512 * MiB);
    // A resolution the session did not open does not count.
    const uint64Pyramid = layer(
      "uint64",
      new Map([
        [FINE, [256, 256, 1]],
        [COARSE, [4096, 4096, 1]],
      ]),
    );
    expect(
      historyBudgetBytes([{ metadata: uint64Pyramid, resolutions: [FINE] }]),
    ).toBe(256 * MiB);
    expect(
      historyBudgetBytes([
        { metadata: uint64Pyramid, resolutions: [FINE, COARSE] },
      ]),
    ).toBe(512 * MiB);
  });

  it("keeps the library default with no writable layer", () => {
    expect(historyBudgetBytes([])).toBe(256 * MiB);
  });
});

describe("editHistoryPolicy", () => {
  it("changes only the content budget", () => {
    expect(
      editHistoryPolicy([
        { metadata: uint64Of([4096, 4096, 1]), resolutions: [FINE] },
      ]),
    ).toEqual({ ...DEFAULT_HISTORY_POLICY, maxContentBytes: 512 * MiB });
  });
});

describe("maxFillHistoryBytes", () => {
  it("is half the session's budget", () => {
    expect(
      maxFillHistoryBytes({
        ...DEFAULT_HISTORY_POLICY,
        maxContentBytes: 512 * MiB,
      }),
    ).toBe(256 * MiB);
  });

  it("lets one 4096² uint64 tile with image redo fill", () => {
    const policy = editHistoryPolicy([
      { metadata: uint64Of([4096, 4096, 1]), resolutions: [FINE] },
    ]);
    // before + after of one tile.
    expect(2 * 128 * MiB).toBeLessThanOrEqual(maxFillHistoryBytes(policy));
  });
});
