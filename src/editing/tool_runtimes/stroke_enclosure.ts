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
 * The area a closed brush stroke encloses (TM-268).
 *
 * Purely geometric: the stroke's swept contour is rasterized into a private
 * buffer and flooded from outside, and whatever the flood cannot reach is the
 * contour plus its interior. Image and segmentation data never take part, so
 * the fill cannot leak out of the stroke the way seeding a flood fill would
 * through a gap the `latestWins` scheduler left in the painted line.
 *
 * Dependency-free apart from the rasterizer, so it runs on any thread.
 */

import type { SessionVoxelBounds } from "@zettaai/edit-session";

import {
  brushBoundsPadding,
  brushSizeVoxels,
  brushStampAnchor,
} from "#src/editing/tool_runtimes/brush_disk_footprint.js";
import type { Vec3 } from "#src/editing/tool_runtimes/paint_rasterize.js";
import { rasterizeStrokeIntoChunk } from "#src/editing/tool_runtimes/paint_rasterize.js";
import type { StrokeFootprintMask } from "#src/editing/tool_runtimes/paint_types.js";

export interface EnclosureLimits {
  /**
   * Ceiling on the contour's rasterization work: the sum of its segments' box
   * areas. A fast scribble of long chords costs far more than a ring of the
   * same bounding box, so the box limit alone would not bound it.
   */
  readonly maxRasterVoxels: number;
  /** Ceiling on the contour's bounding box, checked before allocating it. */
  readonly maxBoxVoxels: number;
  /** Ceiling on the enclosed voxels, excluding the contour itself. */
  readonly maxInteriorVoxels: number;
}

/**
 * The interior ceiling is the number WEBKNOSSOS uses for its fill, which it
 * applies to the bounding box rather than the interior. Ours is deliberately
 * softer on the box because history cost is bounded separately, in bytes.
 */
export const DEFAULT_ENCLOSURE_LIMITS: EnclosureLimits = {
  // About 50 ms on the main thread; see `stroke_enclosure.benchmark.ts`.
  maxRasterVoxels: 8_000_000,
  maxBoxVoxels: 4_000_000,
  maxInteriorVoxels: 5 * 282_690,
};

export type EnclosureResult =
  | {
      readonly kind: "enclosed";
      readonly footprint: StrokeFootprintMask;
      readonly interiorVoxels: number;
    }
  /** The stroke encloses nothing, so it stays exactly as it was painted. */
  | { readonly kind: "open" }
  | { readonly kind: "too-large" };

/** Smallest start-to-end gap still closed; keeps a size-1 brush usable. */
const MIN_CLOSING_GAP_VOXELS = 4;

/** Below what a voxel lattice can show, so the fill's shape does not change. */
const SIMPLIFY_TOLERANCE_VOXELS = 0.5;
/** Bounds the simplification's cost on a very long stroke. */
const SIMPLIFY_MAX_SPAN_POINTS = 256;

const CELL_FREE = 0;
const CELL_CONTOUR = 1;
const CELL_EXTERIOR = 2;

const INITIAL_FLOOD_STACK_CELLS = 1024;

/**
 * Compute what a stroke encloses. `contour` is the stroke's raw path: it is
 * anchored here to the brush lattice so the shape matches the painted one.
 *
 * The box is computed BEFORE clipping to `bounds`: clipped first, a stroke
 * resting against the session wall would close against the wall and report
 * space outside the stroke as enclosed.
 */
export function computeEnclosedFootprint(
  contour: readonly Vec3[],
  radius: number,
  bounds: SessionVoxelBounds | undefined,
  limits: EnclosureLimits = DEFAULT_ENCLOSURE_LIMITS,
): EnclosureResult {
  const exactPath = closedAnchoredPath(contour, radius);
  if (exactPath === undefined) return { kind: "open" };
  const padding = brushBoundsPadding(radius);
  // Many short segments cost far more than the shape they draw: a slowly traced
  // ring must not be refused where the same ring drawn fast fills.
  const path =
    rasterizationCost(exactPath, padding) > limits.maxRasterVoxels
      ? simplifiedPath(exactPath)
      : exactPath;
  if (rasterizationCost(path, padding) > limits.maxRasterVoxels) {
    return { kind: "too-large" };
  }

  // One extra voxel past the footprint on every side leaves a free ring around
  // the contour, so a flood from the corner reaches the whole outside.
  const margin = padding + 1;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of path) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const boxLoX = Math.floor(minX) - margin;
  const boxLoY = Math.floor(minY) - margin;
  const width = Math.ceil(maxX) + margin - boxLoX + 1;
  const height = Math.ceil(maxY) + margin - boxLoY + 1;
  if (width * height > limits.maxBoxVoxels) return { kind: "too-large" };

  const z = path[0][2];
  const cells = new Uint8Array(width * height);
  rasterizeStrokeIntoChunk(cells, {
    points: path,
    radius,
    value: CELL_CONTOUR,
    chunkOrigin: [boxLoX, boxLoY, z],
    chunkSize: [width, height, 1],
  });
  const exteriorVoxels = floodExterior(cells, width, height);

  let contourVoxels = 0;
  for (const cell of cells) {
    if (cell === CELL_CONTOUR) contourVoxels++;
  }
  const interiorVoxels = cells.length - exteriorVoxels - contourVoxels;
  if (interiorVoxels === 0) return { kind: "open" };
  if (interiorVoxels > limits.maxInteriorVoxels) return { kind: "too-large" };

  const footprint = clippedFootprint(
    cells,
    { loX: boxLoX, loY: boxLoY, width, height, z },
    bounds,
  );
  if (footprint === undefined) return { kind: "open" };
  return { kind: "enclosed", footprint, interiorVoxels };
}

/**
 * The anchored path, with a closing segment when the stroke ended near where it
 * started (the same rule as WEBKNOSSOS). A stroke that ends far away gets no
 * closing segment, but can still enclose by crossing itself. `undefined` when
 * the path leaves its z-slice or is too short to enclose anything.
 */
function closedAnchoredPath(
  contour: readonly Vec3[],
  radius: number,
): readonly Vec3[] | undefined {
  if (contour.length < 2) return undefined;
  // Samples landing on one anchor add no shape, yet each would cost a full
  // stamp: a slow stroke would hit the raster limit on a fast one's same shape.
  const path = contour
    .map((point) => brushStampAnchor(point, radius))
    .filter((point, i, points) => i === 0 || !sameAnchor(point, points[i - 1]));
  const [firstX, firstY, firstZ] = path[0];
  if (path.some((point) => point[2] !== firstZ)) return undefined;
  const [lastX, lastY] = path[path.length - 1];
  const gap = Math.hypot(lastX - firstX, lastY - firstY);
  if (gap <= Math.max(brushSizeVoxels(radius), MIN_CLOSING_GAP_VOXELS)) {
    path.push(path[0]);
  }
  return path;
}

/**
 * Greedily drop points the path passes within {@link SIMPLIFY_TOLERANCE_VOXELS}
 * of anyway. Keeps both ends, so a closed path stays closed.
 */
function simplifiedPath(path: readonly Vec3[]): Vec3[] {
  const kept: Vec3[] = [path[0]];
  let start = 0;
  while (start < path.length - 1) {
    const farthest = Math.min(
      path.length - 1,
      start + SIMPLIFY_MAX_SPAN_POINTS,
    );
    let end = start + 1;
    while (end < farthest && spanStaysClose(path, start, end + 1)) end++;
    kept.push(path[end]);
    start = end;
  }
  return kept;
}

function spanStaysClose(
  path: readonly Vec3[],
  start: number,
  end: number,
): boolean {
  const [startX, startY] = path[start];
  const chordX = path[end][0] - startX;
  const chordY = path[end][1] - startY;
  const chordLengthSquared = chordX * chordX + chordY * chordY;
  // A span returning to its start has no chord to measure against.
  if (chordLengthSquared === 0) return false;
  for (let i = start + 1; i < end; i++) {
    const offsetX = path[i][0] - startX;
    const offsetY = path[i][1] - startY;
    // To the chord as a segment, not as a line: a path retracing its own line
    // would otherwise lose the tip of the retrace, which may be what closes it.
    const along = Math.min(
      1,
      Math.max(0, (offsetX * chordX + offsetY * chordY) / chordLengthSquared),
    );
    const distance = Math.hypot(
      offsetX - along * chordX,
      offsetY - along * chordY,
    );
    if (distance > SIMPLIFY_TOLERANCE_VOXELS) return false;
  }
  return true;
}

function sameAnchor(first: Vec3, second: Vec3): boolean {
  return (
    first[0] === second[0] && first[1] === second[1] && first[2] === second[2]
  );
}

function rasterizationCost(path: readonly Vec3[], padding: number): number {
  let cost = 0;
  for (let i = 1; i < path.length; i++) {
    const spanX = Math.abs(path[i][0] - path[i - 1][0]) + 2 * padding + 1;
    const spanY = Math.abs(path[i][1] - path[i - 1][1]) + 2 * padding + 1;
    cost += spanX * spanY;
  }
  return cost;
}

/**
 * Mark everything reachable from the box corner as exterior; returns how many
 * cells that is. 4-connected on purpose: a size-1 brush draws an 8-connected
 * line, and an 8-connected flood would slip through its diagonal steps.
 *
 * Hot path: runs over the whole box on every closed stroke (see
 * `stroke_enclosure.benchmark.ts`), hence the scanline spans over a typed stack.
 */
function floodExterior(
  cells: Uint8Array,
  width: number,
  height: number,
): number {
  let stack = new Int32Array(INITIAL_FLOOD_STACK_CELLS);
  let stackSize = 0;
  const push = (cell: number) => {
    if (stackSize === stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
    }
    stack[stackSize++] = cell;
  };

  let flooded = 0;
  push(0);
  while (stackSize > 0) {
    const seed = stack[--stackSize];
    if (cells[seed] !== CELL_FREE) continue;
    const row = Math.floor(seed / width);
    const rowStart = row * width;
    const rowEnd = rowStart + width;
    let left = seed;
    while (left > rowStart && cells[left - 1] === CELL_FREE) left--;
    let inSpanAbove = false;
    let inSpanBelow = false;
    for (let i = left; i < rowEnd && cells[i] === CELL_FREE; i++) {
      cells[i] = CELL_EXTERIOR;
      flooded++;
      if (row > 0) {
        const free = cells[i - width] === CELL_FREE;
        if (free && !inSpanAbove) push(i - width);
        inSpanAbove = free;
      }
      if (row < height - 1) {
        const free = cells[i + width] === CELL_FREE;
        if (free && !inSpanBelow) push(i + width);
        inSpanBelow = free;
      }
    }
  }
  return flooded;
}

interface EnclosureBox {
  readonly loX: number;
  readonly loY: number;
  readonly width: number;
  readonly height: number;
  readonly z: number;
}

/**
 * Everything the flood did not reach, cropped to the session. Cropping here is
 * required, not an optimization: the worker stamp writes anywhere in a pinned
 * chunk, and a pinned chunk can extend past a region not aligned to the grid.
 */
function clippedFootprint(
  cells: Uint8Array,
  box: EnclosureBox,
  bounds: SessionVoxelBounds | undefined,
): StrokeFootprintMask | undefined {
  if (bounds !== undefined && (box.z < bounds.loZ || box.z >= bounds.hiZ)) {
    return undefined;
  }
  const boxHiX = box.loX + box.width;
  const boxHiY = box.loY + box.height;
  const loX = bounds === undefined ? box.loX : Math.max(box.loX, bounds.loX);
  const loY = bounds === undefined ? box.loY : Math.max(box.loY, bounds.loY);
  const hiX = bounds === undefined ? boxHiX : Math.min(boxHiX, bounds.hiX);
  const hiY = bounds === undefined ? boxHiY : Math.min(boxHiY, bounds.hiY);
  if (loX >= hiX || loY >= hiY) return undefined;

  const maskWidth = hiX - loX;
  const maskHeight = hiY - loY;
  const mask = new Uint8Array(maskWidth * maskHeight);
  for (let row = 0; row < maskHeight; row++) {
    const cellRow = (loY + row - box.loY) * box.width + (loX - box.loX);
    const maskRow = row * maskWidth;
    for (let column = 0; column < maskWidth; column++) {
      if (cells[cellRow + column] !== CELL_EXTERIOR) {
        mask[maskRow + column] = 1;
      }
    }
  }
  return {
    loTx: loX,
    loTy: loY,
    maskW: maskWidth,
    maskH: maskHeight,
    cz: box.z,
    mask,
  };
}

/** How a stroke's undo entry stores its redo; `image` keeps an after-image. */
export type StrokeRedoKind = "image" | "replay";

/**
 * Worst-case bytes a fill adds to the undo history. Entries store whole chunks,
 * however few voxels changed: a before-image for a chunk that was already
 * edited, plus an after-image under `image` redo. A chunk seen for the first
 * time has no before-image, so this over-estimates; there is no way to ask the
 * edit which case applies before writing.
 */
export function fillHistoryBytes(
  tileCount: number,
  chunkSize: readonly [number, number, number],
  bytesPerChunkVoxel: number,
  redoKind: StrokeRedoKind,
): number {
  const chunkBytes =
    chunkSize[0] * chunkSize[1] * chunkSize[2] * bytesPerChunkVoxel;
  return tileCount * chunkBytes * (redoKind === "image" ? 2 : 1);
}
