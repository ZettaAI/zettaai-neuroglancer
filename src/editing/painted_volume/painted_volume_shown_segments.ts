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
 * The preview shows the layer's selected segments — membership decided by the
 * mapped (equivalence-representative) id, exactly as NG decides whether to draw
 * a segment's mesh — plus the segment the brush is painting with, so strokes
 * made right now always appear, even when nothing is selected (Q20) or the
 * brush segment is not selected (Q21). Segment 0 is empty space and is never
 * shown.
 */

import {
  getSegmentEquivalences,
  getVisibleSegments,
} from "#src/segmentation_display_state/base.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";

/**
 * Snapshot of the shown set. It reads the live selection, but its last-id cache
 * is only valid until the selection changes, so the preview builds a new one on
 * every selection or brush-segment change.
 */
export interface PaintedVolumeShownSegments {
  has(id: bigint): boolean;
}

export function paintedVolumeShownSegments(
  displayState: SegmentationDisplayState,
  activeValue: number | bigint,
): PaintedVolumeShownSegments {
  const groupState = displayState.segmentationGroupState.value;
  const visibleSegments = getVisibleSegments(groupState);
  const equivalences = getSegmentEquivalences(groupState);
  const brushSegment = BigInt(activeValue);
  const brushRepresentative =
    brushSegment === 0n ? undefined : equivalences.get(brushSegment);

  const isShown = (id: bigint): boolean => {
    if (id === 0n) return false;
    const representative = equivalences.get(id);
    return (
      representative === brushRepresentative ||
      visibleSegments.has(representative)
    );
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
