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
import { forEachVisibleSegment } from "#src/segmentation_display_state/base.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import { makeFakeSegmentationDisplayState } from "#tests/editing/fakes/fake_segmentation_display_state.js";

describe("paintedVolumeShownSegments", () => {
  it("shows the selected segments and nothing else", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add([5n, 9n]);
    const shown = paintedVolumeShownSegments(fake.displayState);
    expect(shown.has(5n)).toBe(true);
    expect(shown.has(9n)).toBe(true);
    expect(shown.has(7n)).toBe(false);
  });

  it("shows nothing when nothing is selected, as no mesh is drawn", () => {
    const fake = makeFakeSegmentationDisplayState();
    const shown = paintedVolumeShownSegments(fake.displayState);
    expect(shown.has(5n)).toBe(false);
    expect(shown.has(7n)).toBe(false);
  });

  it("shows every member of a selected segment's equivalence class", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentEquivalences.link(3n, 11n);
    fake.visibleSegments.add(fake.segmentEquivalences.get(11n));
    const shown = paintedVolumeShownSegments(fake.displayState);
    expect(shown.has(3n)).toBe(true);
    expect(shown.has(11n)).toBe(true);
    expect(shown.has(12n)).toBe(false);
  });

  it("shows exactly the objects the mesh layer draws", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentEquivalences.link(3n, 11n);
    fake.visibleSegments.add([fake.segmentEquivalences.get(11n), 20n]);
    const meshObjects = new Set<bigint>();
    forEachVisibleSegment(
      fake.displayState.segmentationGroupState.value,
      (objectId) => meshObjects.add(objectId),
    );
    const shown = paintedVolumeShownSegments(fake.displayState);
    for (let id = 1n; id <= 25n; ++id) {
      expect(shown.has(id)).toBe(meshObjects.has(id));
    }
  });

  it("follows the temporary visible set while it is in use, as meshes do", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add(5n);
    fake.temporaryVisibleSegments.add(8n);
    fake.useTemporaryVisibleSegments.value = true;
    const shown = paintedVolumeShownSegments(fake.displayState);
    expect(shown.has(8n)).toBe(true);
    expect(shown.has(5n)).toBe(false);
  });

  it("never shows segment 0, even when selected", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add(0n);
    const shown = paintedVolumeShownSegments(fake.displayState);
    expect(shown.has(0n)).toBe(false);
  });

  it("answers repeated queries consistently across the last-id cache", () => {
    const fake = makeFakeSegmentationDisplayState();
    fake.visibleSegments.add(5n);
    const shown = paintedVolumeShownSegments(fake.displayState);
    const answers = [5n, 5n, 6n, 6n, 5n].map((id) => shown.has(id));
    expect(answers).toEqual([true, true, false, false, true]);
  });

  it("shows the members of a visible root under NONREPRESENTATIVE_EXCLUDED", () => {
    // Graph-backed layers: the mesh object is the root, the voxels hold its
    // supervoxels.
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentEquivalences.disjointSets.visibleSegmentEquivalencePolicy.value =
      VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED;
    fake.segmentEquivalences.link(3n, 11n);
    fake.visibleSegments.add(fake.segmentEquivalences.get(11n));
    const shown = paintedVolumeShownSegments(fake.displayState);
    expect(shown.has(3n)).toBe(true);
    expect(shown.has(11n)).toBe(true);
    expect(shown.has(12n)).toBe(false);
  });

  it.each([
    ["MIN_REPRESENTATIVE", VisibleSegmentEquivalencePolicy.MIN_REPRESENTATIVE],
    ["MAX_REPRESENTATIVE", VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE],
    [
      "MAX_REPRESENTATIVE | REPRESENTATIVE_EXCLUDED",
      VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE |
        VisibleSegmentEquivalencePolicy.REPRESENTATIVE_EXCLUDED,
    ],
  ])("shows exactly the mesh layer's objects under %s", (_name, policy) => {
    const fake = makeFakeSegmentationDisplayState();
    fake.segmentEquivalences.disjointSets.visibleSegmentEquivalencePolicy.value =
      policy;
    const highBitMember = 0x8000000000000005n;
    fake.segmentEquivalences.link(3n, 11n);
    fake.segmentEquivalences.link(11n, highBitMember);
    fake.visibleSegments.add([fake.segmentEquivalences.get(11n), 20n]);
    const meshObjects = new Set<bigint>();
    forEachVisibleSegment(
      fake.displayState.segmentationGroupState.value,
      (objectId) => meshObjects.add(objectId),
    );
    const shown = paintedVolumeShownSegments(fake.displayState);
    for (const id of [
      ...Array.from({ length: 25 }, (_, i) => BigInt(i + 1)),
      highBitMember,
    ]) {
      expect(shown.has(id), `id ${id}`).toBe(meshObjects.has(id));
    }
  });
});
