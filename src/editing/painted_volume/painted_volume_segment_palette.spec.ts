/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest";

import {
  PAINTED_VOLUME_OVERFLOW_CLASS,
  PaintedVolumeSegmentPalette,
} from "#src/editing/painted_volume/painted_volume_segment_palette.js";
import type { PaintedVolumeShownSegments } from "#src/editing/painted_volume/painted_volume_shown_segments.js";
import { makeFakeSegmentationDisplayState } from "#tests/editing/fakes/fake_segmentation_display_state.js";

const SHOW_ALL: PaintedVolumeShownSegments = { has: (id) => id !== 0n };

function classOfId(palette: PaintedVolumeSegmentPalette, id: bigint): number {
  return palette.classOf(
    Number(id & 0xffffffffn),
    Number((id >> 32n) & 0xffffffffn),
  );
}

function rgbaOfClass(
  palette: PaintedVolumeSegmentPalette,
  segmentClass: number,
): number[] {
  return Array.from(
    palette.colors.subarray(segmentClass * 4, segmentClass * 4 + 4),
  );
}

function hashRgb(
  fake: ReturnType<typeof makeFakeSegmentationDisplayState>,
  id: bigint,
): number[] {
  const color = new Float32Array(4);
  fake.segmentColorHash.compute(color, id);
  return [0, 1, 2].map((channel) => Math.round(color[channel] * 255));
}

describe("PaintedVolumeSegmentPalette classes", () => {
  it("gives each new id the next class, starting at 1", () => {
    const palette = new PaintedVolumeSegmentPalette();
    expect(classOfId(palette, 5n)).toBe(1);
    expect(classOfId(palette, 9n)).toBe(2);
    expect(classOfId(palette, 1n << 40n)).toBe(3);
  });

  it("keeps an id's class stable across interleaved lookups", () => {
    const palette = new PaintedVolumeSegmentPalette();
    const ids = [5n, 9n, 5n, 5n, 9n, 13n, 5n];
    const classes = ids.map((id) => classOfId(palette, id));
    expect(classes).toEqual([1, 2, 1, 1, 2, 3, 1]);
  });

  it("tells apart ids that share their low 32 bits", () => {
    const palette = new PaintedVolumeSegmentPalette();
    expect(classOfId(palette, 7n)).toBe(1);
    expect(classOfId(palette, 7n | (1n << 32n))).toBe(2);
    expect(classOfId(palette, 7n)).toBe(1);
  });

  it("hands out 254 classes, then the overflow class", () => {
    const palette = new PaintedVolumeSegmentPalette();
    for (let id = 1n; id <= 254n; ++id) {
      expect(classOfId(palette, id)).toBe(Number(id));
    }
    expect(palette.hasOverflowed).toBe(false);
    expect(classOfId(palette, 255n)).toBe(PAINTED_VOLUME_OVERFLOW_CLASS);
    expect(classOfId(palette, 1000n)).toBe(PAINTED_VOLUME_OVERFLOW_CLASS);
    expect(palette.hasOverflowed).toBe(true);
    expect(classOfId(palette, 17n)).toBe(17);
  });
});

describe("PaintedVolumeSegmentPalette colours", () => {
  it("colours a class like the 2D layer's hash colour", () => {
    const fake = makeFakeSegmentationDisplayState();
    const palette = new PaintedVolumeSegmentPalette();
    const segmentClass = classOfId(palette, 5n);
    palette.refreshColors(fake.displayState, SHOW_ALL);
    expect(rgbaOfClass(palette, segmentClass)).toEqual([
      ...hashRgb(fake, 5n),
      255,
    ]);
  });

  it("uses a stated colour when the segment has one", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentStatedColors.set(5n, 0x00ff8040n);
    const palette = new PaintedVolumeSegmentPalette();
    const segmentClass = classOfId(palette, 5n);
    palette.refreshColors(fake.displayState, SHOW_ALL);
    expect(rgbaOfClass(palette, segmentClass)).toEqual([0x40, 0x80, 0xff, 255]);
  });

  it("blends toward white by (1 - saturation), as the 2D shader does", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentStatedColors.set(5n, 0x00000000n);
    fake.saturation.value = 0.25;
    const palette = new PaintedVolumeSegmentPalette();
    const segmentClass = classOfId(palette, 5n);
    palette.refreshColors(fake.displayState, SHOW_ALL);
    const whiteShare = Math.round(0.75 * 255);
    expect(rgbaOfClass(palette, segmentClass)).toEqual([
      whiteShare,
      whiteShare,
      whiteShare,
      255,
    ]);
  });

  it("colours an equivalent id like its representative", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentEquivalences.link(3n, 11n);
    const representative = fake.segmentEquivalences.get(11n);
    const palette = new PaintedVolumeSegmentPalette();
    const memberClass = classOfId(palette, 11n);
    palette.refreshColors(fake.displayState, SHOW_ALL);
    expect(rgbaOfClass(palette, memberClass)).toEqual([
      ...hashRgb(fake, representative),
      255,
    ]);
  });

  it("colours by the raw id under baseSegmentColoring", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentEquivalences.link(3n, 11n);
    fake.baseSegmentColoring.value = true;
    const palette = new PaintedVolumeSegmentPalette();
    const memberClass = classOfId(palette, 11n);
    palette.refreshColors(fake.displayState, SHOW_ALL);
    expect(rgbaOfClass(palette, memberClass)).toEqual([
      ...hashRgb(fake, 11n),
      255,
    ]);
  });

  it("makes classes of segments that are no longer shown transparent", () => {
    const fake = makeFakeSegmentationDisplayState();
    const palette = new PaintedVolumeSegmentPalette();
    const keptClass = classOfId(palette, 5n);
    const droppedClass = classOfId(palette, 9n);
    palette.refreshColors(fake.displayState, { has: (id) => id === 5n });
    expect(rgbaOfClass(palette, keptClass)[3]).toBe(255);
    expect(rgbaOfClass(palette, droppedClass)[3]).toBe(0);
  });

  it("keeps the empty class transparent and the overflow class opaque grey", () => {
    const fake = makeFakeSegmentationDisplayState();
    const palette = new PaintedVolumeSegmentPalette();
    palette.refreshColors(fake.displayState, SHOW_ALL);
    expect(rgbaOfClass(palette, 0)[3]).toBe(0);
    const [red, green, blue, alpha] = rgbaOfClass(
      palette,
      PAINTED_VOLUME_OVERFLOW_CLASS,
    );
    expect(red).toBe(green);
    expect(green).toBe(blue);
    expect(alpha).toBe(255);
  });

  it("signals changed after refreshing", () => {
    const fake = makeFakeSegmentationDisplayState();
    const palette = new PaintedVolumeSegmentPalette();
    const listener = vi.fn();
    palette.changed.add(listener);
    palette.refreshColors(fake.displayState, SHOW_ALL);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
