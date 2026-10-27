/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import { paintedVolumeShownSegments } from "#src/editing/painted_volume/painted_volume_shown_segments.js";
import { makeFakeSegmentationDisplayState } from "#tests/editing/fakes/fake_segmentation_display_state.js";

describe("paintedVolumeShownSegments", () => {
  it("shows the selected segments and the brush segment", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add([5n, 9n]);
    const shown = paintedVolumeShownSegments(fake.displayState, 7n);
    expect(shown.has(5n)).toBe(true);
    expect(shown.has(9n)).toBe(true);
    expect(shown.has(7n)).toBe(true);
    expect(shown.has(6n)).toBe(false);
  });

  it("shows only the brush segment when nothing is selected (Q20)", () => {
    const fake = makeFakeSegmentationDisplayState();
    const shown = paintedVolumeShownSegments(fake.displayState, 7n);
    expect(shown.has(7n)).toBe(true);
    expect(shown.has(5n)).toBe(false);
  });

  it("shows an unselected brush segment alongside the selection (Q21)", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add(5n);
    const shown = paintedVolumeShownSegments(fake.displayState, 42);
    expect(shown.has(42n)).toBe(true);
    expect(shown.has(5n)).toBe(true);
  });

  it("shows every member of a selected segment's equivalence class", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentEquivalences.link(3n, 11n);
    fake.visibleSegments.add(fake.segmentEquivalences.get(11n));
    const shown = paintedVolumeShownSegments(fake.displayState, 0n);
    expect(shown.has(3n)).toBe(true);
    expect(shown.has(11n)).toBe(true);
    expect(shown.has(12n)).toBe(false);
  });

  it("shows segments merged with the brush segment", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentEquivalences.link(7n, 20n);
    const shown = paintedVolumeShownSegments(fake.displayState, 20n);
    expect(shown.has(7n)).toBe(true);
    expect(shown.has(20n)).toBe(true);
  });

  it("follows the temporary visible set while it is in use, as meshes do", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add(5n);
    fake.temporaryVisibleSegments.add(8n);
    fake.useTemporaryVisibleSegments.value = true;
    const shown = paintedVolumeShownSegments(fake.displayState, 0n);
    expect(shown.has(8n)).toBe(true);
    expect(shown.has(5n)).toBe(false);
  });

  it("never shows segment 0, even as the brush segment or when selected", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add(0n);
    const shown = paintedVolumeShownSegments(fake.displayState, 0n);
    expect(shown.has(0n)).toBe(false);
  });

  it("answers repeated queries consistently across the last-id cache", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add(5n);
    const shown = paintedVolumeShownSegments(fake.displayState, 0n);
    const answers = [5n, 5n, 6n, 6n, 5n].map((id) => shown.has(id));
    expect(answers).toEqual([true, true, false, false, true]);
  });
});
