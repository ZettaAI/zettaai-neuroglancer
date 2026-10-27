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
 * Minimal `SegmentationDisplayState` for tests that read segment selection,
 * equivalences and colours. Built from the real collection classes (no RPC
 * counterpart), so `getBaseObjectColor` and `getVisibleSegments` run their
 * production code paths against it.
 */

import { SegmentColorHash } from "#src/segment_color.js";
import type { SegmentationDisplayStateWithAlpha } from "#src/segmentation_display_state/frontend.js";
import { SegmentSelectionState } from "#src/segmentation_display_state/frontend.js";
import { SharedDisjointUint64Sets } from "#src/shared_disjoint_sets.js";
import { trackableAlphaValue } from "#src/trackable_alpha.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64Map } from "#src/uint64_map.js";
import { Uint64Set } from "#src/uint64_set.js";
import type { vec3, vec4 } from "#src/util/geom.js";

export interface FakeSegmentationDisplayState {
  readonly displayState: SegmentationDisplayStateWithAlpha;
  readonly visibleSegments: Uint64Set;
  readonly segmentEquivalences: SharedDisjointUint64Sets;
  readonly temporaryVisibleSegments: Uint64Set;
  readonly useTemporaryVisibleSegments: WatchableValue<boolean>;
  readonly segmentStatedColors: Uint64Map;
  readonly segmentDefaultColor: WatchableValue<vec3 | undefined>;
  readonly segmentColorHash: SegmentColorHash;
  readonly saturation: WatchableValue<number>;
  readonly baseSegmentColoring: WatchableValue<boolean>;
  readonly segmentSelectionState: SegmentSelectionState;
  readonly hoverHighlight: WatchableValue<boolean>;
  readonly objectAlpha: WatchableValue<number>;
}

export function makeFakeSegmentationDisplayState(): FakeSegmentationDisplayState {
  const visibleSegments = new Uint64Set();
  const segmentEquivalences = new SharedDisjointUint64Sets();
  const temporaryVisibleSegments = new Uint64Set();
  const temporarySegmentEquivalences = new SharedDisjointUint64Sets();
  const useTemporaryVisibleSegments = new WatchableValue(false);
  const useTemporarySegmentEquivalences = new WatchableValue(false);
  const segmentStatedColors = new Uint64Map();
  const tempSegmentStatedColors2d = new Uint64Map();
  const segmentDefaultColor = new WatchableValue<vec3 | undefined>(undefined);
  const segmentColorHash = new SegmentColorHash(0);
  const saturation = trackableAlphaValue(1);
  const baseSegmentColoring = new WatchableValue(false);
  const segmentSelectionState = new SegmentSelectionState();
  const hoverHighlight = new WatchableValue(true);
  const objectAlpha = trackableAlphaValue(1);

  const groupState = {
    visibleSegments,
    segmentEquivalences,
    temporaryVisibleSegments,
    temporarySegmentEquivalences,
    useTemporaryVisibleSegments,
    useTemporarySegmentEquivalences,
  };
  const colorGroupState = {
    segmentStatedColors,
    tempSegmentStatedColors2d,
    segmentDefaultColor,
    segmentColorHash,
  };
  const displayState = {
    segmentationGroupState: new WatchableValue(groupState),
    segmentationColorGroupState: new WatchableValue(colorGroupState),
    useTempSegmentStatedColors2d: new WatchableValue(false),
    honorTempStatedColorAlpha: new WatchableValue(false),
    tempSegmentStatedColors2d: new WatchableValue(tempSegmentStatedColors2d),
    saturation,
    baseSegmentColoring,
    segmentSelectionState,
    hoverHighlight,
    hoverHighlightSuppressed: new WatchableValue(false),
    highlightColor: new WatchableValue<vec4 | undefined>(undefined),
    segmentStatedColors: new WatchableValue(segmentStatedColors),
    objectAlpha,
  } as unknown as SegmentationDisplayStateWithAlpha;

  return {
    displayState,
    visibleSegments,
    segmentEquivalences,
    temporaryVisibleSegments,
    useTemporaryVisibleSegments,
    segmentStatedColors,
    segmentDefaultColor,
    segmentColorHash,
    saturation,
    baseSegmentColoring,
    segmentSelectionState,
    hoverHighlight,
    objectAlpha,
  };
}
