/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import { sizeToRadius } from "#src/editing/brush_size_presets.js";
import {
  brushBoundsPadding,
  brushFootprintContains,
  brushRadiusSquared,
  brushSizeVoxels,
  brushStampAnchor,
} from "#src/editing/tool_runtimes/brush_disk_footprint.js";

/**
 * The voxels a brush of `size` covers for a pointer at `position`, as `"x,y"`
 * keys — the shape read straight off the shared definition, exactly as the
 * rasterizers and the cursor shader read it.
 */
function footprint(
  size: number,
  position: readonly [number, number, number] = [100.5, 200.5, 50.5],
): Set<string> {
  const radius = sizeToRadius(size);
  const [anchorX, anchorY] = brushStampAnchor(position, radius);
  const radiusSquared = brushRadiusSquared(radius);
  const padding = brushBoundsPadding(radius);
  const covered = new Set<string>();
  // Sweep well beyond the padding, so a footprint that reaches further than the
  // rasterizers' scan window would is caught rather than silently clipped.
  const sweep = padding + 3;
  for (
    let voxelY = Math.floor(anchorY) - sweep;
    voxelY <= Math.ceil(anchorY) + sweep;
    ++voxelY
  ) {
    for (
      let voxelX = Math.floor(anchorX) - sweep;
      voxelX <= Math.ceil(anchorX) + sweep;
      ++voxelX
    ) {
      if (
        brushFootprintContains(
          voxelX - anchorX,
          voxelY - anchorY,
          0,
          radiusSquared,
        )
      ) {
        covered.add(`${voxelX},${voxelY}`);
      }
    }
  }
  return covered;
}

/** Per-axis extent of a footprint, in voxels. */
function extent(covered: Set<string>): { width: number; height: number } {
  const xs = [...covered].map((key) => Number(key.split(",")[0]));
  const ys = [...covered].map((key) => Number(key.split(",")[1]));
  return {
    width: Math.max(...xs) - Math.min(...xs) + 1,
    height: Math.max(...ys) - Math.min(...ys) + 1,
  };
}

describe("brush disk footprint", () => {
  it("is exactly `size` voxels across, at every size", () => {
    for (let size = 1; size <= 24; ++size) {
      const { width, height } = extent(footprint(size));
      expect(width, `size ${size} width`).toBe(size);
      expect(height, `size ${size} height`).toBe(size);
    }
  });

  it("never shrinks as the size grows", () => {
    let previous = 0;
    for (let size = 1; size <= 40; ++size) {
      const count = footprint(size).size;
      expect(count, `size ${size}`).toBeGreaterThan(previous);
      previous = count;
    }
  });

  it("keeps every odd size bit-identical to the integer-radius disk", () => {
    // Before even sizes existed the rule was `dx² + dy² ≤ radius²` over integer
    // offsets from the voxel under the pointer. Odd sizes must still be that.
    for (let radius = 0; radius <= 12; ++radius) {
      const legacy = new Set<string>();
      for (let dy = -radius; dy <= radius; ++dy) {
        for (let dx = -radius; dx <= radius; ++dx) {
          if (dx * dx + dy * dy > radius * radius) continue;
          legacy.add(`${100 + dx},${200 + dy}`);
        }
      }
      expect(footprint(2 * radius + 1), `radius ${radius}`).toEqual(legacy);
    }
  });

  it("is symmetric about its anchor at every size", () => {
    for (let size = 1; size <= 16; ++size) {
      const radius = sizeToRadius(size);
      const [anchorX, anchorY] = brushStampAnchor([100.3, 200.7, 50.5], radius);
      const covered = footprint(size, [100.3, 200.7, 50.5]);
      for (const key of covered) {
        const [voxelX, voxelY] = key.split(",").map(Number);
        // Mirror across the anchor on each axis, and swap the axes.
        const mirroredX = 2 * anchorX - voxelX;
        const mirroredY = 2 * anchorY - voxelY;
        expect(covered.has(`${mirroredX},${voxelY}`), `x-mirror ${key}`).toBe(
          true,
        );
        expect(covered.has(`${voxelX},${mirroredY}`), `y-mirror ${key}`).toBe(
          true,
        );
        expect(
          covered.has(
            `${anchorX + (voxelY - anchorY)},${anchorY + (voxelX - anchorX)}`,
          ),
          `transpose ${key}`,
        ).toBe(true);
      }
    }
  });

  it("does not move or reshape while the pointer stays in one voxel", () => {
    // An odd size anchors on the voxel under the pointer, so it is stable across
    // the whole voxel; an even size anchors on the nearest boundary, so it is
    // stable across each half. Either way the shape never changes mid-voxel.
    for (const size of [3, 5, 9]) {
      const reference = footprint(size, [100.01, 200.01, 50.5]);
      for (const fraction of [0.25, 0.5, 0.75, 0.99]) {
        expect(
          footprint(size, [100 + fraction, 200 + fraction, 50.5]),
          `size ${size} at ${fraction}`,
        ).toEqual(reference);
      }
    }
    for (const size of [2, 4, 8]) {
      const reference = footprint(size, [100.01, 200.01, 50.5]);
      for (const fraction of [0.2, 0.49]) {
        expect(
          footprint(size, [100 + fraction, 200 + fraction, 50.5]),
          `size ${size} at ${fraction}`,
        ).toEqual(reference);
      }
    }
  });

  it("anchors an even size on a voxel boundary and an odd size on a voxel", () => {
    expect(brushStampAnchor([100.3, 200.7, 50.9], sizeToRadius(5))).toEqual([
      100, 200, 50,
    ]);
    // Size 4 → radius 1.5 → the nearest boundary: 100 for .3, 201 for .7.
    expect(brushStampAnchor([100.3, 200.7, 50.9], sizeToRadius(4))).toEqual([
      99.5, 200.5, 50,
    ]);
  });

  it("is one voxel thick in Z at every size", () => {
    for (const size of [1, 2, 5, 8, 33]) {
      const radiusSquared = brushRadiusSquared(sizeToRadius(size));
      expect(brushFootprintContains(0, 0, 0, radiusSquared)).toBe(true);
      expect(brushFootprintContains(0, 0, 1, radiusSquared)).toBe(false);
      expect(brushFootprintContains(0, 0, -1, radiusSquared)).toBe(false);
    }
  });

  it("stays inside the scan window the rasterizers use", () => {
    for (let size = 1; size <= 40; ++size) {
      const radius = sizeToRadius(size);
      const [anchorX] = brushStampAnchor([100.5, 200.5, 50.5], radius);
      const padding = brushBoundsPadding(radius);
      const xs = [...footprint(size)].map((key) => Number(key.split(",")[0]));
      expect(Math.min(...xs), `size ${size} lower`).toBeGreaterThanOrEqual(
        Math.floor(anchorX) - padding,
      );
      expect(Math.max(...xs), `size ${size} upper`).toBeLessThanOrEqual(
        Math.ceil(anchorX) + padding,
      );
    }
  });

  it("round-trips size through radius", () => {
    for (let size = 1; size <= 40; ++size) {
      expect(brushSizeVoxels(sizeToRadius(size)), `size ${size}`).toBe(size);
    }
  });
});
