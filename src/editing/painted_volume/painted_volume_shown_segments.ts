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
 * @file Which segments the painted-volume preview shows.
 *
 * Exactly the segments whose meshes NG draws: the objects
 * `forEachVisibleSegment` yields for the layer's group state, which honours the
 * temporary visible set and the equivalence policy the same way the mesh layer
 * does. Nothing else is added, so a segment that is not selected is hidden in
 * the preview just as its mesh is. Segment 0 is empty space and is never shown.
 */

import { forEachVisibleSegment } from "#src/segmentation_display_state/base.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";

/**
 * Snapshot of the shown set, taken when it is built. The preview builds a new
 * one on every selection change.
 */
export interface PaintedVolumeShownSegments {
  has(id: bigint): boolean;
}

export function paintedVolumeShownSegments(
  displayState: SegmentationDisplayState,
): PaintedVolumeShownSegments {
  const shownIds = new Set<bigint>();
  forEachVisibleSegment(
    displayState.segmentationGroupState.value,
    (objectId) => {
      if (objectId !== 0n) shownIds.add(objectId);
    },
  );

  // Neighbouring voxels almost always carry the same id, so one remembered
  // answer turns most queries into a comparison.
  let lastId: bigint | undefined;
  let lastAnswer = false;
  return {
    has(id: bigint): boolean {
      if (id !== lastId) {
        lastId = id;
        lastAnswer = shownIds.has(id);
      }
      return lastAnswer;
    },
  };
}
