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
 * @file The per-slice signed distance field the preview's surface is drawn from.
 *
 * For every texel, the distance within its own z slice to the nearest texel of
 * the other kind (occupied vs empty; texels off the texture are empty), minus
 * the half texel to the outline, signed positive inside, clamped to
 * ±`PAINTED_VOLUME_DISTANCE_RANGE` and encoded in a byte as
 * `0.5 + distance / (2 · range)`. Sampled with linear filtering:
 *
 * - in xy, the half-way crossing follows the shape's outline between texel
 *   centres, so a stroke's voxel staircase becomes a straight or curved edge;
 * - in z, interpolating two slices' distances morphs one slice's outline into
 *   the next (shape-based interpolation), so the slices join in slopes instead
 *   of steps — what mesh simplification does to a stack of contours;
 * - a one-texel-thin stroke keeps a crossing, so nothing thin disappears.
 *
 * Computed on the CPU from a mirror of which texels are occupied, over each
 * written box grown by the range in x and y (the texels whose distance the
 * write can change), separably: the nearest texel of each kind along the row,
 * then the nearest over the rows within range. Rendering the field into the 3-D
 * texture on the GPU instead measured ~15 ms per stroke on Metal (a layer at
 * a time); this is a few tenths of a millisecond.
 */

import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";

type Triple = readonly [number, number, number];

/** Texels; the distance saturates beyond this, so outlines morph across z up to it. */
export const PAINTED_VOLUME_DISTANCE_RANGE = 4;

const RANGE = PAINTED_VOLUME_DISTANCE_RANGE;
/** Row distance meaning "none of that kind within range". */
const BEYOND_RANGE = RANGE + 1;
/**
 * Squared distance meaning "none of the other kind within range": past every
 * real one (at most `2 · range²`), it encodes as saturated.
 */
const NONE_WITHIN_RANGE = 2 * RANGE * RANGE + 1;
/** Distance of a "not seen yet" sentinel: far past the range, still a small int. */
const FAR = 1 << 20;
const MAX_BYTE = 255;

/** Encoded bytes of a box of the distance field, x fastest. */
export interface PaintedVolumeDistanceBox {
  readonly texelBox: TexelBox;
  readonly bytes: Uint8Array;
}

interface WindowCounts {
  readonly nearOccupied: Int32Array;
  readonly nearEmpty: Int32Array;
}

export class PaintedVolumeDistanceField {
  private readonly occupied: Uint8Array;
  private nearOccupiedBuffer = new Int32Array(0);
  private nearEmptyBuffer = new Int32Array(0);
  private windowCapacity = 0;
  private rowsToOccupied = new Uint8Array(0);
  private rowsToEmpty = new Uint8Array(0);
  private output = new Uint8Array(0);

  constructor(private readonly size: Triple) {
    this.occupied = new Uint8Array(size[0] * size[1] * size[2]);
  }

  /** True when this field mirrors a texture of `size` texels. */
  hasSize(size: Triple): boolean {
    return size.every((extent, axis) => extent === this.size[axis]);
  }

  /** Every texel empty again. */
  clear(): void {
    this.occupied.fill(0);
  }

  /**
   * Mirror class `bytes` (x fastest) written into the inclusive `texelBox`.
   * Hot path: runs over every texel of every upload, a whole region on fill.
   */
  writeClasses(texelBox: TexelBox, bytes: Uint8Array): void {
    const boxWidth = texelBox.x1 - texelBox.x0 + 1;
    let source = 0;
    for (let z = texelBox.z0; z <= texelBox.z1; ++z) {
      for (let y = texelBox.y0; y <= texelBox.y1; ++y) {
        const rowStart = this.rowOffset(z, y) + texelBox.x0;
        for (let x = 0; x < boxWidth; ++x) {
          this.occupied[rowStart + x] = bytes[source++] === 0 ? 0 : 1;
        }
      }
    }
  }

  /**
   * The encoded distances a write to `texelBox` can change: the box grown by
   * the range in x and y, clamped to the texture. The bytes are reused by the
   * next call.
   */
  distancesAround(texelBox: TexelBox): PaintedVolumeDistanceBox {
    const [sizeX, sizeY] = this.size;
    const box: TexelBox = {
      x0: Math.max(0, texelBox.x0 - RANGE),
      y0: Math.max(0, texelBox.y0 - RANGE),
      z0: texelBox.z0,
      x1: Math.min(sizeX - 1, texelBox.x1 + RANGE),
      y1: Math.min(sizeY - 1, texelBox.y1 + RANGE),
      z1: texelBox.z1,
    };
    const sliceTexels = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1);
    const bytes = this.outputOfLength(sliceTexels * (box.z1 - box.z0 + 1));
    for (let z = box.z0; z <= box.z1; ++z) {
      this.encodeSlice(box, z, bytes.subarray((z - box.z0) * sliceTexels));
    }
    return { texelBox: box, bytes };
  }

  /** One slice of `box`, into `out` (x fastest). */
  private encodeSlice(box: TexelBox, z: number, out: Uint8Array): void {
    const sizeY = this.size[1];
    const width = box.x1 - box.x0 + 1;
    // Rows within range above and below the box feed its distances.
    const rowsFirst = Math.max(0, box.y0 - RANGE);
    const rowsLast = Math.min(sizeY - 1, box.y1 + RANGE);
    this.ensureRowBuffers((rowsLast - rowsFirst + 1) * width);
    for (let y = rowsFirst; y <= rowsLast; ++y) {
      this.measureRow(z, y, box.x0, box.x1, (y - rowsFirst) * width);
    }
    // Per column, how many rows of the window around the current row have a
    // texel of each kind within range: where none of a texel's other kind
    // does, its distance saturates without the exact search.
    const windows = this.windowCounts(width);
    windows.nearOccupied.fill(0);
    windows.nearEmpty.fill(0);
    for (
      let row = rowsFirst;
      row <= Math.min(rowsLast, box.y0 + RANGE);
      ++row
    ) {
      this.countRow(row, rowsFirst, width, 1);
    }
    for (let y = box.y0; y <= box.y1; ++y) {
      if (y > box.y0) {
        if (y + RANGE <= rowsLast)
          this.countRow(y + RANGE, rowsFirst, width, 1);
        if (y - RANGE - 1 >= rowsFirst) {
          this.countRow(y - RANGE - 1, rowsFirst, width, -1);
        }
      }
      const windowLeavesTexture = y - RANGE < 0 || y + RANGE >= sizeY;
      this.encodeRow(
        box,
        z,
        y,
        rowsFirst,
        out,
        (y - box.y0) * width,
        windowLeavesTexture,
        windows,
      );
    }
  }

  /** Add (`sign` 1) or remove (-1) one buffered row's near-kind flags. */
  private countRow(
    row: number,
    rowsFirst: number,
    width: number,
    sign: 1 | -1,
  ): void {
    const { rowsToOccupied, rowsToEmpty } = this;
    const { nearOccupied, nearEmpty } = this.windowCounts(width);
    const rowOffset = (row - rowsFirst) * width;
    for (let column = 0; column < width; ++column) {
      if (rowsToOccupied[rowOffset + column] <= RANGE) {
        nearOccupied[column] += sign;
      }
      if (rowsToEmpty[rowOffset + column] <= RANGE) nearEmpty[column] += sign;
    }
  }

  /** Per-column window counts `width` long, reusing the buffers. */
  private windowCounts(width: number): WindowCounts {
    if (this.windowCapacity < width) {
      this.nearOccupiedBuffer = new Int32Array(width);
      this.nearEmptyBuffer = new Int32Array(width);
      this.windowCapacity = width;
    }
    return {
      nearOccupied: this.nearOccupiedBuffer.subarray(0, width),
      nearEmpty: this.nearEmptyBuffer.subarray(0, width),
    };
  }

  /**
   * Hot path (every texel a stroke's upload can affect; a 1025-voxel brush
   * spent 180 ms here with a per-texel call, `sqrt` and encoding): one row of
   * encoded distances. Squared distances are integers up to `2 · range²`, so
   * the nearest is found as the least `along² + rowDelta²` over the rows
   * within range and encoded through a table.
   */
  private encodeRow(
    box: TexelBox,
    z: number,
    y: number,
    rowsFirst: number,
    out: Uint8Array,
    outOffset: number,
    windowLeavesTexture: boolean,
    windows: WindowCounts,
  ): void {
    const sizeY = this.size[1];
    const { occupied, rowsToOccupied, rowsToEmpty } = this;
    const { nearOccupied, nearEmpty } = windows;
    const width = box.x1 - box.x0 + 1;
    const ownRow = (y - rowsFirst) * width;
    const sliceRow = this.rowOffset(z, y) + box.x0;
    for (let column = 0; column < width; ++column) {
      const inside = occupied[sliceRow + column] !== 0;
      if (inside) {
        // Rows off the texture are empty, so only a window inside it can
        // leave an inside texel saturated.
        if (!windowLeavesTexture && nearEmpty[column] === 0) {
          out[outOffset + column] = ENCODED_INSIDE[NONE_WITHIN_RANGE];
          continue;
        }
      } else if (nearOccupied[column] === 0) {
        out[outOffset + column] = ENCODED_OUTSIDE[NONE_WITHIN_RANGE];
        continue;
      }
      const rows = inside ? rowsToEmpty : rowsToOccupied;
      let nearestSquared = NONE_WITHIN_RANGE;
      for (let rowDelta = -RANGE; rowDelta <= RANGE; ++rowDelta) {
        const row = y + rowDelta;
        const rowDeltaSquared = rowDelta * rowDelta;
        if (row < 0 || row >= sizeY) {
          // Off the texture: all empty, so only an inside texel finds one.
          if (inside && rowDeltaSquared < nearestSquared) {
            nearestSquared = rowDeltaSquared;
          }
          continue;
        }
        const along = rows[ownRow + rowDelta * width + column];
        if (along > RANGE) continue;
        const distanceSquared = along * along + rowDeltaSquared;
        if (distanceSquared < nearestSquared) nearestSquared = distanceSquared;
      }
      out[outOffset + column] = inside
        ? ENCODED_INSIDE[nearestSquared]
        : ENCODED_OUTSIDE[nearestSquared];
    }
  }

  /**
   * Hot path (runs for every texel a stroke's upload can affect): along row
   * `y` of slice `z`, the distance from each column of `[x0, x1]` to the
   * nearest occupied and the nearest empty texel within range, by one sweep
   * each way.
   */
  private measureRow(
    z: number,
    y: number,
    x0: number,
    x1: number,
    rowOffset: number,
  ): void {
    const sizeX = this.size[0];
    const sliceRow = this.rowOffset(z, y);
    const { occupied, rowsToOccupied, rowsToEmpty } = this;
    // Integer sentinels far past the range keep the arithmetic in small ints.
    let lastOccupied = x0 - FAR;
    let lastEmpty = x0 - FAR;
    for (let x = x0 - RANGE; x < x0; ++x) {
      if (x >= 0 && occupied[sliceRow + x] !== 0) lastOccupied = x;
      else lastEmpty = x;
    }
    for (let x = x0; x <= x1; ++x) {
      if (x < sizeX && occupied[sliceRow + x] !== 0) lastOccupied = x;
      else lastEmpty = x;
      const column = rowOffset + x - x0;
      const toOccupied = x - lastOccupied;
      const toEmpty = x - lastEmpty;
      rowsToOccupied[column] = toOccupied > RANGE ? BEYOND_RANGE : toOccupied;
      rowsToEmpty[column] = toEmpty > RANGE ? BEYOND_RANGE : toEmpty;
    }
    let nextOccupied = x1 + FAR;
    let nextEmpty = x1 + FAR;
    for (let x = x1 + RANGE; x > x1; --x) {
      if (x < sizeX && occupied[sliceRow + x] !== 0) nextOccupied = x;
      else nextEmpty = x;
    }
    for (let x = x1; x >= x0; --x) {
      if (x >= 0 && occupied[sliceRow + x] !== 0) nextOccupied = x;
      else nextEmpty = x;
      const column = rowOffset + x - x0;
      const toOccupied = nextOccupied - x;
      const toEmpty = nextEmpty - x;
      if (toOccupied < rowsToOccupied[column]) {
        rowsToOccupied[column] = toOccupied;
      }
      if (toEmpty < rowsToEmpty[column]) rowsToEmpty[column] = toEmpty;
    }
  }

  /** Index in `occupied` of texel (0, y, z). */
  private rowOffset(z: number, y: number): number {
    const [sizeX, sizeY] = this.size;
    return (z * sizeY + y) * sizeX;
  }

  private ensureRowBuffers(length: number): void {
    if (this.rowsToOccupied.length < length) {
      this.rowsToOccupied = new Uint8Array(length);
      this.rowsToEmpty = new Uint8Array(length);
    }
  }

  private outputOfLength(length: number): Uint8Array {
    if (this.output.length < length) this.output = new Uint8Array(length);
    return this.output.subarray(0, length);
  }
}

/** A signed distance, clamped to the range, as the texture's byte. */
function encodeDistance(signedDistance: number): number {
  const clamped = Math.max(-RANGE, Math.min(RANGE, signedDistance));
  return Math.round((0.5 + clamped / (2 * RANGE)) * MAX_BYTE);
}

/** Encoded byte of an inside / outside texel by its nearest squared distance. */
function encodingTable(sign: 1 | -1): Uint8Array {
  const table = new Uint8Array(NONE_WITHIN_RANGE + 1);
  for (
    let distanceSquared = 0;
    distanceSquared < table.length;
    ++distanceSquared
  ) {
    const nearest =
      distanceSquared === NONE_WITHIN_RANGE
        ? RANGE + 0.5
        : Math.sqrt(distanceSquared);
    table[distanceSquared] = encodeDistance(sign * (nearest - 0.5));
  }
  return table;
}

const ENCODED_INSIDE = encodingTable(1);
const ENCODED_OUTSIDE = encodingTable(-1);
