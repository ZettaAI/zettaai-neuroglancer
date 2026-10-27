/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { SessionVoxelBounds } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import { planPaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";

type Triple = readonly [number, number, number];

const MEBIBYTE = 1024 * 1024;
const DEFAULT_BUDGET_BYTES = 256 * MEBIBYTE;
const ORIGIN: Triple = [0, 0, 0];

function boundsOf(lo: Triple, hi: Triple): SessionVoxelBounds {
  return {
    loX: lo[0],
    loY: lo[1],
    loZ: lo[2],
    hiX: hi[0],
    hiY: hi[1],
    hiZ: hi[2],
  };
}

/** Every extent must cover the region and keep each factor block in one chunk. */
function expectValidExtent(
  extent: PaintedVolumeExtent,
  lo: Triple,
  hi: Triple,
  chunkDataSize: Triple,
  voxelOffset: Triple,
): void {
  for (let axis = 0; axis < 3; axis++) {
    const factor = extent.factor[axis];
    const origin = extent.textureOrigin[axis];
    expect(Number.isInteger(Math.log2(factor))).toBe(true);
    expect(chunkDataSize[axis] % factor).toBe(0);
    // `Math.abs`: a negative multiple leaves `-0`, which `toBe(0)` rejects.
    expect(Math.abs((origin - voxelOffset[axis]) % factor)).toBe(0);
    expect(origin).toBeLessThanOrEqual(lo[axis]);
    expect(origin).toBeGreaterThan(lo[axis] - factor);
    const textureEnd = origin + extent.textureSize[axis] * factor;
    expect(textureEnd).toBeGreaterThanOrEqual(hi[axis]);
    expect(textureEnd - factor).toBeLessThan(hi[axis]);
  }
}

/** The chunk index (along one axis) holding a voxel. */
function chunkIndexOf(voxel: number, chunkSize: number, offset: number) {
  return Math.floor((voxel - offset) / chunkSize);
}

describe("planPaintedVolumeExtent", () => {
  it("keeps full resolution when the region fits", () => {
    const extent = planPaintedVolumeExtent(
      boundsOf([0, 0, 0], [512, 512, 512]),
      [64, 64, 64],
      ORIGIN,
      2048,
      DEFAULT_BUDGET_BYTES,
    );
    expect(extent).toEqual({
      textureOrigin: [0, 0, 0],
      factor: [1, 1, 1],
      textureSize: [512, 512, 512],
    });
  });

  it("starts the texture at bounds.lo when it is already on the grid", () => {
    const extent = planPaintedVolumeExtent(
      boundsOf([128, 64, 16], [640, 576, 48]),
      [64, 64, 16],
      ORIGIN,
      2048,
      DEFAULT_BUDGET_BYTES,
    );
    expect(extent?.textureOrigin).toEqual([128, 64, 16]);
    expect(extent?.textureSize).toEqual([512, 512, 32]);
  });

  it("downsamples x and y when they exceed the texture dimension limit", () => {
    const extent = planPaintedVolumeExtent(
      boundsOf([0, 0, 0], [4096, 4096, 10]),
      [128, 128, 16],
      ORIGIN,
      2048,
      DEFAULT_BUDGET_BYTES,
    );
    expect(extent).toEqual({
      textureOrigin: [0, 0, 0],
      factor: [2, 2, 1],
      textureSize: [2048, 2048, 10],
    });
  });

  it("downsamples only the axis that exceeds the dimension limit", () => {
    const extent = planPaintedVolumeExtent(
      boundsOf([0, 0, 0], [4096, 300, 10]),
      [128, 128, 16],
      ORIGIN,
      2048,
      DEFAULT_BUDGET_BYTES,
    );
    expect(extent?.factor).toEqual([2, 1, 1]);
  });

  it("grows x and y, not z, to fit the memory budget", () => {
    // 1024 x 1024 x 64 at factor 1 is 64 MiB; a 16 MiB budget needs (2, 2, 1).
    const extent = planPaintedVolumeExtent(
      boundsOf([0, 0, 0], [1024, 1024, 64]),
      [64, 64, 64],
      ORIGIN,
      2048,
      16 * MEBIBYTE,
    );
    expect(extent).toEqual({
      textureOrigin: [0, 0, 0],
      factor: [2, 2, 1],
      textureSize: [512, 512, 64],
    });
  });

  it("downsamples z for the budget only once x and y cannot grow", () => {
    // x and y chunks are 2 wide, so their factor caps at 2.
    const extent = planPaintedVolumeExtent(
      boundsOf([0, 0, 0], [64, 64, 1024]),
      [2, 2, 64],
      ORIGIN,
      2048,
      512 * 1024,
    );
    expect(extent?.factor).toEqual([2, 2, 2]);
    expect(extent?.textureSize).toEqual([32, 32, 512]);
  });

  it("downsamples z when z alone exceeds the dimension limit", () => {
    const extent = planPaintedVolumeExtent(
      boundsOf([0, 0, 0], [256, 256, 4096]),
      [64, 64, 64],
      ORIGIN,
      2048,
      DEFAULT_BUDGET_BYTES,
    );
    expect(extent?.factor).toEqual([1, 1, 2]);
    expect(extent?.textureSize).toEqual([256, 256, 2048]);
  });

  it("aligns an off-grid origin down to the factor grid of the chunks", () => {
    const voxelOffset: Triple = [3, 5, 7];
    const lo: Triple = [100, 200, 30];
    const hi: Triple = [4100, 4200, 40];
    const extent = planPaintedVolumeExtent(
      boundsOf(lo, hi),
      [64, 64, 64],
      voxelOffset,
      2048,
      DEFAULT_BUDGET_BYTES,
    );
    expect(extent).toEqual({
      textureOrigin: [99, 199, 30],
      factor: [2, 2, 1],
      textureSize: [2001, 2001, 10],
    });
    expectValidExtent(extent!, lo, hi, [64, 64, 64], voxelOffset);
  });

  it("never lets a factor block cross a chunk boundary", () => {
    const chunkDataSize: Triple = [64, 32, 16];
    const offsets: Triple[] = [
      [0, 0, 0],
      [3, 5, 7],
      [-10, 17, 1],
    ];
    const lows: Triple[] = [
      [0, 0, 0],
      [1, 33, 9],
      [127, 63, 15],
      [-5, 2, 3],
    ];
    const spans: Triple[] = [
      [100, 100, 20],
      [5000, 3000, 40],
      [9000, 9000, 5000],
    ];
    for (const voxelOffset of offsets) {
      for (const lo of lows) {
        for (const span of spans) {
          const hi: Triple = [
            lo[0] + span[0],
            lo[1] + span[1],
            lo[2] + span[2],
          ];
          const extent = planPaintedVolumeExtent(
            boundsOf(lo, hi),
            chunkDataSize,
            voxelOffset,
            2048,
            DEFAULT_BUDGET_BYTES,
          );
          expect(extent).toBeDefined();
          expectValidExtent(extent!, lo, hi, chunkDataSize, voxelOffset);
          for (let axis = 0; axis < 3; axis++) {
            const factor = extent!.factor[axis];
            const texelCount = extent!.textureSize[axis];
            for (const texel of [0, 1, texelCount - 1]) {
              const blockStart = extent!.textureOrigin[axis] + texel * factor;
              const blockEnd = blockStart + factor - 1;
              expect(
                chunkIndexOf(blockEnd, chunkDataSize[axis], voxelOffset[axis]),
              ).toBe(
                chunkIndexOf(
                  blockStart,
                  chunkDataSize[axis],
                  voxelOffset[axis],
                ),
              );
            }
          }
        }
      }
    }
  });

  it("only uses factors that divide the chunk size", () => {
    // 100 = 4 * 25: the largest power-of-two factor on x is 4.
    const extent = planPaintedVolumeExtent(
      boundsOf([0, 0, 0], [8000, 100, 10]),
      [100, 64, 64],
      ORIGIN,
      2048,
      DEFAULT_BUDGET_BYTES,
    );
    expect(extent?.factor).toEqual([4, 1, 1]);
    expect(extent?.textureSize).toEqual([2000, 100, 10]);
  });

  it("gives up when no dividing factor fits the dimension limit", () => {
    expect(
      planPaintedVolumeExtent(
        boundsOf([0, 0, 0], [9000, 100, 10]),
        [100, 64, 64],
        ORIGIN,
        2048,
        DEFAULT_BUDGET_BYTES,
      ),
    ).toBeUndefined();
  });

  it("gives up when no dividing factor fits the budget", () => {
    expect(
      planPaintedVolumeExtent(
        boundsOf([0, 0, 0], [64, 64, 64]),
        [2, 2, 2],
        ORIGIN,
        2048,
        1000,
      ),
    ).toBeUndefined();
  });

  it("rejects an empty or inverted region", () => {
    const plan = (lo: Triple, hi: Triple) =>
      planPaintedVolumeExtent(
        boundsOf(lo, hi),
        [64, 64, 64],
        ORIGIN,
        2048,
        DEFAULT_BUDGET_BYTES,
      );
    expect(plan([0, 0, 0], [64, 64, 0])).toBeUndefined();
    expect(plan([10, 0, 0], [5, 64, 64])).toBeUndefined();
  });

  it("rejects non-positive limits", () => {
    const bounds = boundsOf([0, 0, 0], [64, 64, 64]);
    expect(
      planPaintedVolumeExtent(bounds, [64, 64, 64], ORIGIN, 0, 1e9),
    ).toBeUndefined();
    expect(
      planPaintedVolumeExtent(bounds, [64, 64, 64], ORIGIN, 2048, 0),
    ).toBeUndefined();
  });
});
