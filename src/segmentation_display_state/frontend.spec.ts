import { describe, expect, it } from "vitest";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import {
  ghostSegmentDither,
  SegmentWidgetFactory,
  SegmentWidgetWithExtraColumnsFactory,
  resolveStatedColor,
  unpackColorWithAlpha,
} from "#src/segmentation_display_state/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64Map } from "#src/uint64_map.js";
import { Uint64Set } from "#src/uint64_set.js";
import { vec4 } from "#src/util/geom.js";

describe("resolveStatedColor", () => {
  it("prefers the temp map when useTemp is true and the id is present", () => {
    const temp = new Uint64Map();
    temp.set(5n, 0xffn);
    const persistent = new Uint64Map();
    persistent.set(5n, 0x11n);
    expect(resolveStatedColor(true, temp, persistent, 5n)).toBe(0xffn);
  });
  it("falls back to the persistent map when useTemp is false", () => {
    const temp = new Uint64Map();
    temp.set(5n, 0xffn);
    const persistent = new Uint64Map();
    persistent.set(5n, 0x11n);
    expect(resolveStatedColor(false, temp, persistent, 5n)).toBe(0x11n);
  });
  it("falls back to the persistent map when the id is absent from temp", () => {
    const temp = new Uint64Map();
    const persistent = new Uint64Map();
    persistent.set(5n, 0x11n);
    expect(resolveStatedColor(true, temp, persistent, 5n)).toBe(0x11n);
  });
});

describe("ghostSegmentDither", () => {
  const opaqueGold = (0xffn << 24n) | 0x00d7ffn;
  const dimGold = (0x14n << 24n) | 0x00d7ffn;

  it("asks for no dithering on a fully opaque color", () => {
    const out = vec4.fromValues(-1, -1, -1, -1);
    expect(ghostSegmentDither(opaqueGold, out)).toBe(1);
    expect(Array.from(out)).toEqual([-1, -1, -1, -1]);
  });
  it("returns the packed alpha as the fraction of pixels to keep", () => {
    const out = vec4.create();
    expect(ghostSegmentDither(dimGold, out)).toBeCloseTo(0x14 / 255, 4);
  });
  it("keeps the color at full brightness so only the dither fades it", () => {
    const out = vec4.create();
    ghostSegmentDither(dimGold, out);
    expect(out[0]).toBe(1);
    expect(out[1]).toBeCloseTo(0xd7 / 255, 4);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1);
  });
});

describe("unpackColorWithAlpha", () => {
  it("extracts r/g/b and scales fallbackAlpha by the packed alpha byte", () => {
    const packed = (0x80n << 24n) | (0x00n << 16n) | (0x84n << 8n) | 0xffn;
    const out = new Float32Array(4);
    unpackColorWithAlpha(packed, out, 1.0);
    expect(out[0]).toBeCloseTo(1.0, 2);
    expect(out[1]).toBeCloseTo(132 / 255, 2);
    expect(out[2]).toBeCloseTo(0, 2);
    expect(out[3]).toBeCloseTo((0x80 / 255) * 1.0, 2);
  });
  it("uses fallbackAlpha unscaled when the packed alpha byte is zero", () => {
    const packed = 0x00ffffffn;
    const out = new Float32Array(4);
    unpackColorWithAlpha(packed, out, 0.7);
    expect(out[3]).toBeCloseTo(0.7, 2);
  });
});

function makeFakeDisplayState(
  annotationExcludedSegments: WatchableValue<Uint64Set | undefined> | undefined,
): SegmentationDisplayState {
  const statedColors = new Uint64Map();
  const fake = {
    segmentationGroupState: new WatchableValue({
      segmentEquivalences: { size: 0 },
      segmentPropertyMap: { value: undefined },
      maxIdLength: new WatchableValue(0),
      visibleSegments: new Uint64Set(),
      selectedSegments: new Uint64Set(),
    }),
    segmentationColorGroupState: new WatchableValue({
      segmentStatedColors: statedColors,
      segmentDefaultColor: new WatchableValue(undefined),
      segmentColorHash: { compute: () => {} },
    }),
    segmentSelectionState: { hasSelectedSegment: false },
    segmentStatedColors: new WatchableValue(statedColors),
    tempSegmentStatedColors2d: new WatchableValue(new Uint64Map()),
    useTempSegmentStatedColors2d: new WatchableValue(false),
    honorTempStatedColorAlpha: new WatchableValue(false),
    baseSegmentColoring: new WatchableValue(false),
    annotationExcludedSegments,
  };
  return fake as unknown as SegmentationDisplayState;
}

describe("segment list annotation button", () => {
  const SEGMENT_ID = 7n;
  const ANNOTATIONS_SELECTOR = ".neuroglancer-segment-list-entry-annotations";
  const OFF_CLASS = "neuroglancer-annotations-off";

  function makeRow(
    excludedSegments: WatchableValue<Uint64Set | undefined> | undefined,
  ) {
    const factory = SegmentWidgetFactory.make(
      makeFakeDisplayState(excludedSegments),
      false,
    );
    const row = factory.get(SEGMENT_ID);
    const button = row.querySelector(ANNOTATIONS_SELECTOR) as HTMLElement;
    return { factory, row, button };
  }

  it("keeps the annotation button hidden without annotationExcludedSegments", () => {
    expect(makeRow(undefined).button.hidden).toBe(true);
  });

  it("shows the button on a row created before the set was assigned", () => {
    const excludedSegments = new WatchableValue<Uint64Set | undefined>(
      undefined,
    );
    const { factory, row, button } = makeRow(excludedSegments);
    expect(button.hidden).toBe(true);
    excludedSegments.value = new Uint64Set();
    factory.update(row);
    expect(button.hidden).toBe(false);
  });

  it("click toggles the segment in the excluded set and the off class follows it", () => {
    const excluded = new Uint64Set();
    const { factory, row, button } = makeRow(new WatchableValue(excluded));
    expect(button.hidden).toBe(false);
    expect(button.classList.contains(OFF_CLASS)).toBe(false);
    button.click();
    expect(excluded.has(SEGMENT_ID)).toBe(true);
    factory.update(row);
    expect(button.classList.contains(OFF_CLASS)).toBe(true);
    button.click();
    expect(excluded.has(SEGMENT_ID)).toBe(false);
    factory.update(row);
    expect(button.classList.contains(OFF_CLASS)).toBe(false);
  });

  it("click after the set is cleared does nothing", () => {
    const set = new Uint64Set();
    const excludedSegments = new WatchableValue<Uint64Set | undefined>(set);
    const { button } = makeRow(excludedSegments);
    excludedSegments.value = undefined;
    expect(() => button.click()).not.toThrow();
    expect(button.classList.contains(OFF_CLASS)).toBe(false);
    expect(set.has(SEGMENT_ID)).toBe(false);
  });

  function stickyVisibility(element: Element) {
    return Array.from(
      element.children[0].children,
      (c) => (c as HTMLElement).hidden,
    );
  }

  it("keeps the header and rows aligned with and without the set", () => {
    const excludedSegments = new WatchableValue<Uint64Set | undefined>(
      undefined,
    );
    const { factory, row } = makeRow(excludedSegments);
    const headerFactory = new SegmentWidgetWithExtraColumnsFactory(
      makeFakeDisplayState(excludedSegments),
      document.createElement("div"),
      () => true,
    );
    const { container: header } = headerFactory.getHeader();
    expect(stickyVisibility(header)).toEqual(stickyVisibility(row));
    expect(
      header.querySelector<HTMLElement>(ANNOTATIONS_SELECTOR)!.hidden,
    ).toBe(true);
    excludedSegments.value = new Uint64Set();
    factory.update(row);
    headerFactory.updateHeader(header);
    expect(stickyVisibility(header)).toEqual(stickyVisibility(row));
    expect(
      header.querySelector<HTMLElement>(ANNOTATIONS_SELECTOR)!.hidden,
    ).toBe(false);
  });
});
