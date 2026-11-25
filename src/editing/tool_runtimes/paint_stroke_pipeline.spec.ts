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
import { describe, it, expect } from "vitest";

import { sizeToRadius } from "#src/editing/brush_size_presets.js";
import {
  brushBoundsPadding,
  brushFootprintContains,
  brushRadiusSquared,
  brushStampAnchor,
} from "#src/editing/tool_runtimes/brush_disk_footprint.js";

import type {
  Vec3,
  VoxelView,
} from "#src/editing/tool_runtimes/paint_rasterize.js";
import { stampMaskIntoChunk } from "#src/editing/tool_runtimes/paint_rasterize.js";
import {
  chunksForFootprint,
  chunksForStroke,
  PaintStrokePipeline,
  type ChunkTile,
} from "#src/editing/tool_runtimes/paint_stroke_pipeline.js";

import type { StrokeFootprintMask } from "#src/editing/tool_runtimes/paint_types.js";
import { buildFootprintBatch } from "#src/editing/tool_runtimes/painting_compute.js";
import { computeEnclosedFootprint } from "#src/editing/tool_runtimes/stroke_enclosure.js";

const CS: [number, number, number] = [64, 64, 64];

function keys(tiles: readonly ChunkTile[]): string[] {
  return tiles.map((t) => `${t.coord.x},${t.coord.y},${t.coord.z}`).sort();
}

describe("chunksForStroke", () => {
  it("returns the single chunk a small stroke lies within, with correct origin", () => {
    const pts: Vec3[] = [
      [10, 10, 5],
      [40, 20, 5],
    ];
    const tiles = chunksForStroke(pts, 4, CS);
    expect(keys(tiles)).toEqual(["0,0,0"]);
    expect(tiles[0].origin).toEqual([0, 0, 0]);
  });

  it("enumerates both chunks a stroke spanning an X boundary covers", () => {
    const pts: Vec3[] = [
      [50, 10, 5],
      [80, 10, 5],
    ];
    const tiles = chunksForStroke(pts, 5, CS);
    expect(keys(tiles)).toEqual(["0,0,0", "1,0,0"]);
    const t1 = tiles.find((t) => t.coord.x === 1)!;
    expect(t1.origin).toEqual([64, 0, 0]);
  });

  it("expands by the radius into a neighbouring chunk", () => {
    // A single stamp at x=60, r=8 reaches x=68 → crosses the x=64 boundary.
    const tiles = chunksForStroke([[60, 10, 5]], 8, CS);
    expect(keys(tiles)).toEqual(["0,0,0", "1,0,0"]);
  });

  it("dedupes chunks shared by adjacent segments (L-shape)", () => {
    const pts: Vec3[] = [
      [10, 10, 5],
      [60, 10, 5],
      [60, 60, 5],
    ];
    expect(keys(chunksForStroke(pts, 2, CS))).toEqual(["0,0,0"]);
  });

  it("clips the footprint to the session bounds in X", () => {
    const bounds: SessionVoxelBounds = {
      loX: 0,
      loY: 0,
      loZ: 0,
      hiX: 64, // valid x is [0, 63]
      hiY: 256,
      hiZ: 256,
    };
    const pts: Vec3[] = [
      [50, 10, 5],
      [80, 10, 5],
    ];
    // Without bounds this spans chunks 0 and 1; clipped to x<64 only chunk 0.
    expect(keys(chunksForStroke(pts, 5, CS, bounds))).toEqual(["0,0,0"]);
  });

  it("returns nothing when the z-slice is outside the session bounds", () => {
    const bounds: SessionVoxelBounds = {
      loX: 0,
      loY: 0,
      loZ: 0,
      hiX: 256,
      hiY: 256,
      hiZ: 64,
    };
    expect(chunksForStroke([[10, 10, 100]], 4, CS, bounds)).toEqual([]);
  });

  /**
   * The safety property: `paintSegment` only writes the tiles this returns, so a
   * short box drops paint at a chunk boundary. Its per-segment padding is
   * `floor(radius)`, which is exact only because the points are stamp ANCHORS —
   * an even size's half-voxel anchor supplies the half voxel the smaller padding
   * leaves out. That is subtle enough to pin directly against the shape.
   */
  it("covers the painted footprint at every size", () => {
    const chunkSize: [number, number, number] = [8, 8, 8];
    for (let size = 1; size <= 12; ++size) {
      const radius = sizeToRadius(size);
      for (const fraction of [0, 0.1, 0.5, 0.9]) {
        const anchor = brushStampAnchor(
          [40 + fraction, 40 + fraction, 5],
          radius,
        );
        const tiles = chunksForStroke([anchor], radius, chunkSize);
        const covered = new Set(tiles.map((t) => `${t.coord.x},${t.coord.y}`));
        const radiusSquared = brushRadiusSquared(radius);
        const sweep = brushBoundsPadding(radius) + 2;
        for (
          let voxelY = Math.floor(anchor[1]) - sweep;
          voxelY <= Math.ceil(anchor[1]) + sweep;
          ++voxelY
        ) {
          for (
            let voxelX = Math.floor(anchor[0]) - sweep;
            voxelX <= Math.ceil(anchor[0]) + sweep;
            ++voxelX
          ) {
            if (
              !brushFootprintContains(
                voxelX - anchor[0],
                voxelY - anchor[1],
                0,
                radiusSquared,
              )
            ) {
              continue;
            }
            const tile = `${Math.floor(voxelX / chunkSize[0])},${Math.floor(
              voxelY / chunkSize[1],
            )}`;
            expect(
              covered.has(tile),
              `size ${size} fraction ${fraction}: voxel (${voxelX}, ${voxelY}) is in tile ${tile}, which was not enumerated`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("returns nothing for an empty point list", () => {
    expect(chunksForStroke([], 4, CS)).toEqual([]);
  });
});

describe("PaintStrokePipeline (non-isolated environment)", () => {
  it("reports unavailable and invalidate() is a safe no-op without SAB", () => {
    // The test environment is not cross-origin isolated, so SharedArrayBuffer
    // backing is unavailable and the pipeline degrades to the fallback path.
    const pipeline = new PaintStrokePipeline();
    expect(pipeline.available).toBe(false);
    expect(() => pipeline.invalidate()).not.toThrow();
  });
});

describe("chunksForFootprint", () => {
  // An L: the top-right chunk of its box holds nothing.
  const footprint: StrokeFootprintMask = (() => {
    const maskW = 128;
    const maskH = 128;
    const mask = new Uint8Array(maskW * maskH);
    for (let row = 0; row < maskH; row++) {
      for (let column = 0; column < maskW; column++) {
        if (column < 64 || row >= 64) mask[row * maskW + column] = 1;
      }
    }
    return { loTx: 0, loTy: 0, maskW, maskH, cz: 3, mask };
  })();

  it("leaves out tiles the mask does not paint", () => {
    expect(keys(chunksForFootprint(footprint, CS))).toEqual([
      "0,0,0",
      "0,1,0",
      "1,1,0",
    ]);
  });

  it("anchors tiles on the chunk grid origin", () => {
    const tiles = chunksForFootprint(footprint, CS, undefined, [10, 0, 0]);
    expect(tiles[0].origin).toEqual([-54, 0, 0]);
    expect(tiles.some((tile) => tile.coord.x === -1)).toBe(true);
  });
});

describe("closed-stroke fill: worker stamp and main-thread batch agree", () => {
  const SIZE: [number, number, number] = [32, 32, 32];
  const voxelKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

  /** A region not aligned to the chunk grid, so bounds cut through chunks. */
  const bounds: SessionVoxelBounds = {
    loX: 15,
    loY: 12,
    loZ: 0,
    hiX: 77,
    hiY: 90,
    hiZ: 64,
  };

  function enclosedFootprint(): StrokeFootprintMask {
    const result = computeEnclosedFootprint(
      [
        [5, 20, 3],
        [60, 20, 3],
        [60, 110, 3],
        [5, 110, 3],
        [5, 20, 3],
      ],
      2,
      bounds,
    );
    if (result.kind !== "enclosed") throw new Error(result.kind);
    return result.footprint;
  }

  function viaWorkerKernel(
    footprint: StrokeFootprintMask,
    voxelOffset: Vec3,
  ): Set<string> {
    const painted = new Set<string>();
    const elementCount = SIZE[0] * SIZE[1] * SIZE[2];
    const tiles = chunksForFootprint(footprint, SIZE, bounds, voxelOffset);
    for (const tile of tiles) {
      const view: VoxelView = new Uint32Array(elementCount);
      stampMaskIntoChunk(view, {
        mask: footprint.mask,
        maskW: footprint.maskW,
        maskH: footprint.maskH,
        loTx: footprint.loTx,
        loTy: footprint.loTy,
        cz: footprint.cz,
        value: 7,
        chunkOrigin: tile.origin,
        chunkSize: SIZE,
      });
      view.forEach((value, index) => {
        if (value === 0) return;
        const localY = Math.floor(index / SIZE[0]) % SIZE[1];
        const localZ = Math.floor(index / (SIZE[0] * SIZE[1]));
        painted.add(
          voxelKey(
            tile.origin[0] + (index % SIZE[0]),
            tile.origin[1] + localY,
            tile.origin[2] + localZ,
          ),
        );
      });
    }
    return painted;
  }

  function viaMainThreadBatch(
    footprint: StrokeFootprintMask,
    voxelOffset: Vec3,
  ): Set<string> {
    const metadata = {
      layerId: "target",
      voxelDataType: "uint32",
      channels: 1,
      scales: [
        {
          resolution: "r",
          voxelSizeNm: [8, 8, 40],
          voxelOffset,
          sizeVoxels: [256, 256, 256],
          chunkDataSize: SIZE,
        },
      ],
    } as never;
    const batch = buildFootprintBatch(
      metadata,
      "target" as never,
      "r" as never,
      footprint,
      7,
    );
    // The same coordinate math as `applyPaintBatch`, independent of the offset.
    const painted = new Set<string>();
    for (const write of batch.chunks) {
      const [originX, originY, originZ] = write.subregion.origin;
      const [sizeX, sizeY] = write.subregion.size;
      for (let row = 0; row < sizeY; row++) {
        for (let column = 0; column < sizeX; column++) {
          if (write.valueMask?.[row * sizeX + column] === 0) continue;
          painted.add(
            voxelKey(
              write.chunkCoord.x * SIZE[0] + originX + column,
              write.chunkCoord.y * SIZE[1] + originY + row,
              write.chunkCoord.z * SIZE[2] + originZ,
            ),
          );
        }
      }
    }
    return painted;
  }

  it.each<[string, Vec3]>([
    ["a zero offset", [0, 0, 0]],
    ["a non-zero offset", [10, 7, 2]],
  ])("paints the same voxels with %s", (_label, voxelOffset) => {
    const footprint = enclosedFootprint();
    const worker = viaWorkerKernel(footprint, voxelOffset);
    const mainThread = viaMainThreadBatch(footprint, voxelOffset);
    expect(worker.size).toBeGreaterThan(0);
    expect([...worker].sort()).toEqual([...mainThread].sort());
  });

  it("stays inside a session region not aligned to the chunk grid", () => {
    for (const key of viaWorkerKernel(enclosedFootprint(), [0, 0, 0])) {
      const [x, y] = key.split(",").map(Number);
      expect(x).toBeGreaterThanOrEqual(bounds.loX);
      expect(x).toBeLessThan(bounds.hiX);
      expect(y).toBeGreaterThanOrEqual(bounds.loY);
      expect(y).toBeLessThan(bounds.hiY);
    }
  });
});
