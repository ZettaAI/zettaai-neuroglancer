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
 * Exactly the voxels of the segments whose meshes NG draws: the objects
 * `forEachVisibleSegment` yields for the layer's group state, which honours the
 * temporary visible set and the equivalence policy the same way the mesh layer
 * does. Nothing else is added, so a segment that is not selected is hidden in
 * the preview just as its mesh is. Segment 0 is empty space and is never shown.
 *
 * Each id is answered by its representative, as the 2D layer does, instead of
 * enumerating every member of every visible set: under
 * `NONREPRESENTATIVE_EXCLUDED` the mesh objects are the visible roots while the
 * voxels hold their members, and an agglomerated selection can have tens of
 * thousands of members.
 */

import {
  getSegmentEquivalences,
  getVisibleSegments,
} from "#src/segmentation_display_state/base.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";

/**
 * The shown set, read from the group state's current selection. The preview
 * builds a new one on every selection change.
 */
export interface PaintedVolumeShownSegments {
  has(id: bigint): boolean;
}

const HIGH_BIT = 0x8000000000000000n;

export function paintedVolumeShownSegments(
  displayState: SegmentationDisplayState,
): PaintedVolumeShownSegments {
  const groupState = displayState.segmentationGroupState.value;
  const visibleSegments = getVisibleSegments(groupState);
  const equivalences = getSegmentEquivalences(groupState);
  const policy =
    equivalences.disjointSets.visibleSegmentEquivalencePolicy.value;
  const membersAreMeshes = !(
    policy & VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED
  );
  // forEachVisibleSegment's filter of graph-added (high-bit) members.
  const skipsHighBitMembers =
    (policy & VisibleSegmentEquivalencePolicy.REPRESENTATIVE_EXCLUDED) !== 0 &&
    (policy & VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE) !== 0;

  const isShown = (id: bigint): boolean => {
    if (id === 0n) return false;
    if (skipsHighBitMembers && membersAreMeshes && (id & HIGH_BIT) !== 0n) {
      return false;
    }
    if (visibleSegments.has(equivalences.get(id))) return true;
    // Under NONREPRESENTATIVE_EXCLUDED a visible id is a mesh object itself.
    return !membersAreMeshes && visibleSegments.has(id);
  };

  // Neighbouring voxels almost always carry the same id, so one remembered
  // answer turns most queries into a comparison.
  let lastId: bigint | undefined;
  let lastAnswer = false;
  return {
    has(id: bigint): boolean {
      if (id !== lastId) {
        lastId = id;
        lastAnswer = isShown(id);
      }
      return lastAnswer;
    },
  };
}
