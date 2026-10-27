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
 * @file Segment id → one-byte class, and the RGBA colour of every class.
 *
 * The painted-volume texture stores one byte per texel: `0` is empty, `1..254`
 * index this palette, `255` stands for any segment seen after the 254 classes
 * ran out. Colours are a 256 × RGBA8 table the shader samples by class, so a
 * colour change re-uploads 1 KiB instead of the volume.
 *
 * The palette only grows: texels written earlier must keep pointing at their
 * colour, so a segment that stops being shown keeps its class and turns
 * transparent instead. Colours are the mesh layer's: `getObjectColor` of the
 * mapped id (or the raw id under `baseSegmentColoring`), so saturation and the
 * hover highlight match the segment's mesh.
 */

import type { PaintedVolumeShownSegments } from "#src/editing/painted_volume/painted_volume_shown_segments.js";
import { getSegmentEquivalences } from "#src/segmentation_display_state/base.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import { getObjectColor } from "#src/segmentation_display_state/frontend.js";
import { NullarySignal } from "#src/util/signal.js";

export const PAINTED_VOLUME_EMPTY_CLASS = 0;
export const PAINTED_VOLUME_OVERFLOW_CLASS = 255;
export const PAINTED_VOLUME_PALETTE_SIZE = 256;

const FIRST_SEGMENT_CLASS = 1;
const RGBA_CHANNELS = 4;
const OPAQUE = 255;
const TRANSPARENT = 0;
/** Overflow segments are drawn neutral grey; the shader cannot read CSS tokens. */
const OVERFLOW_GREY = 128;

export class PaintedVolumeSegmentPalette {
  /** RGBA8 per class, `PAINTED_VOLUME_PALETTE_SIZE` entries. */
  readonly colors = new Uint8Array(PAINTED_VOLUME_PALETTE_SIZE * RGBA_CHANNELS);
  readonly changed = new NullarySignal();

  private readonly classById = new Map<bigint, number>();
  private nextClass = FIRST_SEGMENT_CLASS;
  private overflowed = false;
  private lastLow = 0;
  private lastHigh = 0;
  private lastClass = PAINTED_VOLUME_EMPTY_CLASS;

  constructor() {
    this.writeColor(
      PAINTED_VOLUME_OVERFLOW_CLASS,
      OVERFLOW_GREY,
      OVERFLOW_GREY,
      OVERFLOW_GREY,
      OPAQUE,
    );
  }

  /**
   * Segments holding their own class. A new class has no colour until the next
   * `refreshColors`, so the owner refreshes when this grows.
   */
  get classCount(): number {
    return this.classById.size;
  }

  /** True once some segment got the overflow class instead of its own. */
  get hasOverflowed(): boolean {
    return this.overflowed;
  }

  /**
   * Class of the non-zero segment id `(high32 << 32) | low32`. The split form
   * lets the occupancy kernel read ids through `Uint32Array` views without a
   * BigInt per voxel.
   */
  classOf(low32: number, high32: number): number {
    if (
      low32 === this.lastLow &&
      high32 === this.lastHigh &&
      this.lastClass !== PAINTED_VOLUME_EMPTY_CLASS
    ) {
      return this.lastClass;
    }
    const id = (BigInt(high32 >>> 0) << 32n) | BigInt(low32 >>> 0);
    let segmentClass = this.classById.get(id);
    if (segmentClass === undefined) {
      segmentClass = this.assignClass(id);
    }
    this.lastLow = low32;
    this.lastHigh = high32;
    this.lastClass = segmentClass;
    return segmentClass;
  }

  /**
   * Recompute every class colour from the layer's current colouring, as the
   * mesh layer colours its objects; classes whose segment is not in `shown`
   * become transparent.
   */
  refreshColors(
    displayState: SegmentationDisplayState,
    shown: PaintedVolumeShownSegments,
  ): void {
    const equivalences = getSegmentEquivalences(
      displayState.segmentationGroupState.value,
    );
    const colorByRawId = displayState.baseSegmentColoring.value;
    for (const [id, segmentClass] of this.classById) {
      const colorId = colorByRawId ? id : equivalences.get(id);
      const color = getObjectColor(displayState, colorId);
      this.writeColor(
        segmentClass,
        colorByte(color[0]),
        colorByte(color[1]),
        colorByte(color[2]),
        shown.has(id) ? OPAQUE : TRANSPARENT,
      );
    }
    this.changed.dispatch();
  }

  private assignClass(id: bigint): number {
    if (this.nextClass >= PAINTED_VOLUME_OVERFLOW_CLASS) {
      this.overflowed = true;
      return PAINTED_VOLUME_OVERFLOW_CLASS;
    }
    const segmentClass = this.nextClass++;
    this.classById.set(id, segmentClass);
    return segmentClass;
  }

  private writeColor(
    segmentClass: number,
    red: number,
    green: number,
    blue: number,
    alpha: number,
  ): void {
    const offset = segmentClass * RGBA_CHANNELS;
    this.colors[offset] = red;
    this.colors[offset + 1] = green;
    this.colors[offset + 2] = blue;
    this.colors[offset + 3] = alpha;
  }
}

/** One `getObjectColor` channel as a byte. */
function colorByte(channel: number): number {
  return Math.round(channel * 255);
}
