/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountSegmentListWidget } from "#src/editing/adapters/segment_list_widget.js";
import { getCssColor } from "#src/segment_color.js";
import { getBaseObjectColor } from "#src/segmentation_display_state/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64OrderedSet } from "#src/uint64_ordered_set.js";
import { Uint64Set } from "#src/uint64_set.js";
import { vec3 } from "#src/util/geom.js";
import { makeFakeSegmentationDisplayState } from "#tests/editing/fakes/fake_segmentation_display_state.js";

/** The fake plus what NG's segment row reads beyond rendering. */
function displayStateForRow() {
  const fake = makeFakeSegmentationDisplayState();
  Object.assign(fake.displayState.segmentationGroupState.value, {
    selectedSegments: new Uint64OrderedSet(),
    maxIdLength: new WatchableValue(0),
    segmentPropertyMap: new WatchableValue(undefined),
  });
  Object.assign(fake.displayState, {
    annotationExcludedSegments: new WatchableValue(new Uint64Set()),
    selectSegment: vi.fn(),
  });
  return fake;
}

let parent: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
  parent = document.createElement("div");
  document.body.appendChild(parent);
});

afterEach(() => {
  parent.remove();
  vi.useRealTimers();
});

/** `color` as the browser stores it on an element's style, as NG sets it. */
function styleColor(color: vec3): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = getCssColor(color);
  return probe.style.backgroundColor;
}

const idChip = () =>
  parent.querySelector<HTMLElement>(".neuroglancer-segment-list-entry-id")!;

describe("mountSegmentListWidget", () => {
  it("mounts NG's segment-list row, coloured as NG colours the segment", () => {
    const fake = displayStateForRow();
    mountSegmentListWidget(fake.displayState, parent, 5n);
    expect(parent.querySelector(".neuroglancer-segment-list-entry")).not.toBe(
      null,
    );
    expect(idChip().textContent).toBe("5");
    expect(idChip().style.backgroundColor).toBe(
      styleColor(getBaseObjectColor(fake.displayState, 5n) as vec3),
    );
  });

  it("follows a colour change on the layer", () => {
    const fake = displayStateForRow();
    mountSegmentListWidget(fake.displayState, parent, 5n);
    fake.segmentDefaultColor.value = vec3.fromValues(0, 1, 0);
    vi.advanceTimersToNextFrame();
    expect(idChip().style.backgroundColor).toBe(
      styleColor(vec3.fromValues(0, 1, 0)),
    );
  });

  it("highlights the segment on hover through NG's own row", () => {
    const fake = displayStateForRow();
    mountSegmentListWidget(fake.displayState, parent, 5n);
    const row = parent.querySelector(".neuroglancer-segment-list-entry")!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    expect(fake.segmentSelectionState.isSelected(5n)).toBe(true);
    row.dispatchEvent(new MouseEvent("mouseleave"));
    expect(fake.segmentSelectionState.hasSelectedSegment).toBe(false);
  });

  it("clears the highlight when removed mid-hover", () => {
    const fake = displayStateForRow();
    const unmount = mountSegmentListWidget(fake.displayState, parent, 5n);
    parent
      .querySelector(".neuroglancer-segment-list-entry")!
      .dispatchEvent(new MouseEvent("mouseenter"));
    unmount();
    expect(fake.segmentSelectionState.hasSelectedSegment).toBe(false);
  });

  it("leaves another row's highlight alone when removed without hover", () => {
    const fake = displayStateForRow();
    const unmount = mountSegmentListWidget(fake.displayState, parent, 5n);
    fake.segmentSelectionState.set(9n);
    unmount();
    expect(fake.segmentSelectionState.isSelected(9n)).toBe(true);
  });

  it("removes the row and stops following the layer once unmounted", () => {
    const fake = displayStateForRow();
    const unmount = mountSegmentListWidget(fake.displayState, parent, 5n);
    const chip = idChip();
    const before = chip.style.backgroundColor;
    unmount();
    expect(parent.childElementCount).toBe(0);
    fake.segmentDefaultColor.value = vec3.fromValues(0, 1, 0);
    vi.advanceTimersToNextFrame();
    expect(chip.style.backgroundColor).toBe(before);
  });
});
