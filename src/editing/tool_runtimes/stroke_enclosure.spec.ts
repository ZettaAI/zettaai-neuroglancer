/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import { sizeToRadius } from "#src/editing/brush_size_presets.js";
import type { Vec3 } from "#src/editing/tool_runtimes/paint_rasterize.js";
import { rasterizeStrokeIntoChunk } from "#src/editing/tool_runtimes/paint_rasterize.js";
import type { StrokeFootprintMask } from "#src/editing/tool_runtimes/paint_types.js";
import type { EnclosureLimits } from "#src/editing/tool_runtimes/stroke_enclosure.js";
import {
  computeEnclosedFootprint,
  DEFAULT_ENCLOSURE_LIMITS,
  fillHistoryBytes,
} from "#src/editing/tool_runtimes/stroke_enclosure.js";

const Z = 7;
const FAR_BOUNDS = {
  loX: -10_000,
  loY: -10_000,
  loZ: -10_000,
  hiX: 10_000,
  hiY: 10_000,
  hiZ: 10_000,
};

function circle(
  centerX: number,
  centerY: number,
  circleRadius: number,
  steps = 64,
): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    points.push([
      centerX + circleRadius * Math.cos(angle),
      centerY + circleRadius * Math.sin(angle),
      Z,
    ]);
  }
  return points;
}

function enclosed(
  contour: readonly Vec3[],
  radius: number,
  bounds = FAR_BOUNDS,
): { footprint: StrokeFootprintMask; interiorVoxels: number } {
  const result = computeEnclosedFootprint(contour, radius, bounds);
  if (result.kind !== "enclosed") {
    throw new Error(`expected an enclosure, got ${result.kind}`);
  }
  return result;
}

function covers(
  footprint: StrokeFootprintMask,
  voxelX: number,
  voxelY: number,
): boolean {
  const column = voxelX - footprint.loTx;
  const row = voxelY - footprint.loTy;
  if (
    column < 0 ||
    row < 0 ||
    column >= footprint.maskW ||
    row >= footprint.maskH
  ) {
    return false;
  }
  return footprint.mask[row * footprint.maskW + column] === 1;
}

describe("computeEnclosedFootprint", () => {
  it("fills inside a closed circle and nothing outside it", () => {
    const { footprint, interiorVoxels } = enclosed(circle(100, 100, 30), 3);
    expect(covers(footprint, 100, 100)).toBe(true);
    expect(covers(footprint, 100, 125)).toBe(true);
    expect(covers(footprint, 100, 140)).toBe(false);
    expect(covers(footprint, 140, 140)).toBe(false);
    expect(footprint.cz).toBe(Z);
    expect(interiorVoxels).toBeGreaterThan(0);
  });

  it("contains every voxel the brush paints along the contour", () => {
    const contour = circle(50, 50, 20, 24);
    const radius = 3;
    const { footprint } = enclosed(contour, radius);
    const size = 120;
    const painted = new Uint8Array(size * size);
    rasterizeStrokeIntoChunk(painted, {
      points: contour.map(
        ([x, y, z]) => [Math.floor(x), Math.floor(y), z] as Vec3,
      ),
      radius,
      value: 1,
      chunkOrigin: [0, 0, Z],
      chunkSize: [size, size, 1],
    });
    for (let voxelY = 0; voxelY < size; voxelY++) {
      for (let voxelX = 0; voxelX < size; voxelX++) {
        if (painted[voxelY * size + voxelX] === 1) {
          expect(covers(footprint, voxelX, voxelY)).toBe(true);
        }
      }
    }
  });

  it("closes a small gap between the stroke's end and its start", () => {
    // Stops 5 voxels short of closing; a size-7 brush bridges that.
    const contour = circle(100, 100, 30, 64).slice(0, 63);
    const { footprint } = enclosed(contour, 3);
    expect(covers(footprint, 100, 100)).toBe(true);
  });

  it("does not charge the raster limit for samples on the same anchor", () => {
    const corners: Vec3[] = [
      [10, 10, 0],
      [50, 10, 0],
      [50, 50, 0],
      [10, 50, 0],
      [10, 10, 0],
    ];
    const slowStroke = corners.flatMap((corner) =>
      Array.from({ length: 5000 }, (): Vec3 => corner),
    );
    const result = computeEnclosedFootprint(slowStroke, 2, undefined, {
      maxRasterVoxels: 10_000,
      maxBoxVoxels: 100_000,
      maxInteriorVoxels: 100_000,
    });
    expect(result.kind).toBe("enclosed");
  });

  it("fills a slowly traced ring the same as one drawn fast", () => {
    const ring = (stepVoxels: number): Vec3[] => {
      const ringRadius = 400;
      const samples = Math.ceil((2 * Math.PI * ringRadius) / stepVoxels);
      return Array.from({ length: samples + 1 }, (_, i): Vec3 => {
        const angle = (2 * Math.PI * i) / samples;
        return [
          500 + ringRadius * Math.cos(angle),
          500 + ringRadius * Math.sin(angle),
          5,
        ];
      });
    };
    const slow = computeEnclosedFootprint(ring(1), 33, undefined);
    const fast = computeEnclosedFootprint(ring(24), 33, undefined);
    expect(slow.kind).toBe("enclosed");
    expect(fast.kind).toBe("enclosed");
    if (slow.kind !== "enclosed" || fast.kind !== "enclosed") return;
    const relativeDifference =
      Math.abs(slow.interiorVoxels - fast.interiorVoxels) / fast.interiorVoxels;
    expect(relativeDifference).toBeLessThan(0.01);
  });

  it("keeps the tip of a retraced line when simplifying, since it can close the stroke", () => {
    const line = (from: Vec3, to: Vec3): Vec3[] => {
      const steps = Math.max(
        Math.abs(to[0] - from[0]),
        Math.abs(to[1] - from[1]),
      );
      return Array.from({ length: steps }, (_, i): Vec3 => {
        const fraction = (i + 1) / steps;
        return [
          from[0] + fraction * (to[0] - from[0]),
          from[1] + fraction * (to[1] - from[1]),
          5,
        ];
      });
    };
    // Three sides of a square, then out along the fourth to the start and back:
    // only the retrace's tip closes the square, and the stroke ends far away.
    const start: Vec3 = [300, 300, 5];
    const stroke: Vec3[] = [
      start,
      ...line(start, [300, 500, 5]),
      ...line([300, 500, 5], [500, 500, 5]),
      ...line([500, 500, 5], [500, 300, 5]),
      ...line([500, 300, 5], start),
      ...line(start, [500, 300, 5]),
      ...line([500, 300, 5], [500, 0, 5]),
    ];
    const roomy = {
      maxBoxVoxels: 10_000_000,
      maxInteriorVoxels: 10_000_000,
    };
    const exact = computeEnclosedFootprint(stroke, 2, undefined, {
      ...roomy,
      maxRasterVoxels: Number.MAX_SAFE_INTEGER,
    });
    const simplified = computeEnclosedFootprint(stroke, 2, undefined, {
      ...roomy,
      maxRasterVoxels: 20_000,
    });
    expect(exact.kind).toBe("enclosed");
    expect(simplified.kind).toBe("enclosed");
    if (exact.kind !== "enclosed" || simplified.kind !== "enclosed") return;
    expect(simplified.interiorVoxels).toBe(exact.interiorVoxels);
  });

  it("still refuses a stroke whose simplified shape is over the raster limit", () => {
    const zigzag = Array.from(
      { length: 200 },
      (_, i): Vec3 => [i % 2 === 0 ? 0 : 500, i * 5, 5],
    );
    const result = computeEnclosedFootprint(zigzag, 8, undefined, {
      maxRasterVoxels: 100_000,
      maxBoxVoxels: 10_000_000,
      maxInteriorVoxels: 10_000_000,
    });
    expect(result.kind).toBe("too-large");
  });

  it("leaves an open arc alone", () => {
    const arc = circle(100, 100, 30, 64).slice(0, 33);
    expect(computeEnclosedFootprint(arc, 3, FAR_BOUNDS).kind).toBe("open");
  });

  it("leaves a straight line and a single point alone", () => {
    const line: Vec3[] = [
      [0, 0, Z],
      [50, 0, Z],
    ];
    expect(computeEnclosedFootprint(line, 3, FAR_BOUNDS).kind).toBe("open");
    expect(computeEnclosedFootprint([[0, 0, Z]], 3, FAR_BOUNDS).kind).toBe(
      "open",
    );
  });

  it("encloses a loop that crosses itself even when the ends are far apart", () => {
    const contour: Vec3[] = [
      [0, 50, Z],
      [100, 50, Z],
      [100, 100, Z],
      [50, 100, Z],
      [50, 0, Z],
    ];
    const { footprint } = enclosed(contour, 1);
    expect(covers(footprint, 75, 75)).toBe(true);
    // Outside the crossing loop, where the two tails run.
    expect(covers(footprint, 25, 75)).toBe(false);
    expect(covers(footprint, 75, 25)).toBe(false);
  });

  it("fills both lobes of a figure eight", () => {
    const contour: Vec3[] = [
      [0, 0, Z],
      [40, 40, Z],
      [80, 0, Z],
      [80, 40, Z],
      [40, 0, Z],
      [0, 40, Z],
      [0, 0, Z],
    ];
    const { footprint } = enclosed(contour, 1);
    expect(covers(footprint, 10, 20)).toBe(true);
    expect(covers(footprint, 70, 20)).toBe(true);
  });

  describe("spiral", () => {
    const spiral = (growthPerTurn: number): Vec3[] => {
      const contour: Vec3[] = [];
      const turns = 3;
      const stepsPerTurn = 48;
      for (let i = 0; i <= turns * stepsPerTurn; i++) {
        const angle = (2 * Math.PI * i) / stepsPerTurn;
        const reach = 10 + (growthPerTurn * i) / stepsPerTurn;
        contour.push([
          100 + reach * Math.cos(angle),
          100 + reach * Math.sin(angle),
          Z,
        ]);
      }
      return contour;
    };

    it("is enclosed when its turns touch under the brush", () => {
      const { footprint } = enclosed(spiral(5), 3);
      expect(covers(footprint, 100, 100)).toBe(true);
      expect(covers(footprint, 100, 160)).toBe(false);
    });

    it("is open when a channel leads out between its turns", () => {
      expect(computeEnclosedFootprint(spiral(20), 3, FAR_BOUNDS).kind).toBe(
        "open",
      );
    });
  });

  it("does not leak through the diagonal steps of a size-1 brush", () => {
    // A diamond: every side is a pure diagonal, so the outline is 8-connected.
    const contour: Vec3[] = [
      [20, 0, Z],
      [40, 20, Z],
      [20, 40, Z],
      [0, 20, Z],
      [20, 0, Z],
    ];
    const { footprint } = enclosed(contour, sizeToRadius(1));
    expect(covers(footprint, 20, 20)).toBe(true);
    expect(covers(footprint, 2, 2)).toBe(false);
  });

  it("anchors an even brush size to the same lattice as the stroke", () => {
    const radius = sizeToRadius(4);
    const { footprint } = enclosed(circle(60, 60, 20), radius);
    expect(covers(footprint, 60, 60)).toBe(true);
    expect(covers(footprint, 60, 90)).toBe(false);
  });

  it("does not treat the session wall as part of the outline", () => {
    // A U resting against the wall at y=0: open in the stroke's own geometry.
    const contour: Vec3[] = [
      [10, 3, Z],
      [10, 40, Z],
      [60, 40, Z],
      [60, 3, Z],
    ];
    const bounds = { ...FAR_BOUNDS, loY: 0 };
    expect(computeEnclosedFootprint(contour, 3, bounds).kind).toBe("open");
  });

  it("crops a loop crossing the session wall without writing past it", () => {
    const bounds = { ...FAR_BOUNDS, hiX: 100 };
    const { footprint } = enclosed(circle(100, 100, 30), 3, bounds);
    expect(footprint.loTx + footprint.maskW).toBe(100);
    expect(covers(footprint, 99, 100)).toBe(true);
    expect(covers(footprint, 100, 100)).toBe(false);
  });

  it("is open when the stroke's slice lies outside the session", () => {
    const bounds = { ...FAR_BOUNDS, hiZ: Z };
    const result = computeEnclosedFootprint(circle(100, 100, 30), 3, bounds);
    expect(result.kind).toBe("open");
  });

  it("is open when the path leaves its z-slice", () => {
    const contour = circle(100, 100, 30);
    contour[10] = [contour[10][0], contour[10][1], Z + 1];
    expect(computeEnclosedFootprint(contour, 3, FAR_BOUNDS).kind).toBe("open");
  });

  it("works with a non-zero chunk-grid origin and negative coordinates", () => {
    const { footprint } = enclosed(circle(-500, -700, 30), 3);
    expect(covers(footprint, -500, -700)).toBe(true);
    expect(covers(footprint, -500, -650)).toBe(false);
  });

  describe("limits", () => {
    const roomy: EnclosureLimits = {
      maxRasterVoxels: Number.MAX_SAFE_INTEGER,
      maxBoxVoxels: Number.MAX_SAFE_INTEGER,
      maxInteriorVoxels: Number.MAX_SAFE_INTEGER,
    };
    const result = (limits: EnclosureLimits) =>
      computeEnclosedFootprint(circle(100, 100, 30), 3, FAR_BOUNDS, limits)
        .kind;

    it("accepts the stroke when every limit is roomy", () => {
      expect(result(roomy)).toBe("enclosed");
    });
    it("enforces the rasterization limit", () => {
      expect(result({ ...roomy, maxRasterVoxels: 100 })).toBe("too-large");
    });
    it("enforces the box limit before allocating the box", () => {
      const huge: Vec3[] = [
        [0, 0, Z],
        [1_000_000, 0, Z],
        [1_000_000, 1_000_000, Z],
        [0, 1_000_000, Z],
        [0, 0, Z],
      ];
      const outcome = computeEnclosedFootprint(huge, 3, FAR_BOUNDS, {
        ...roomy,
        maxBoxVoxels: DEFAULT_ENCLOSURE_LIMITS.maxBoxVoxels,
      });
      expect(outcome.kind).toBe("too-large");
    });
    it("enforces the interior limit", () => {
      expect(result({ ...roomy, maxInteriorVoxels: 10 })).toBe("too-large");
    });
  });
});

describe("fillHistoryBytes", () => {
  it("counts whole chunks, doubled for an after-image under image redo", () => {
    const chunk64Bytes = 64 * 64 * 64 * 8;
    expect(fillHistoryBytes(3, [64, 64, 64], 8, "replay")).toBe(
      3 * chunk64Bytes,
    );
    expect(fillHistoryBytes(3, [64, 64, 64], 8, "image")).toBe(
      6 * chunk64Bytes,
    );
  });
});
