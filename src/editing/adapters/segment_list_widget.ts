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
 * @file NG's own segment-list row, mounted in an editing panel (TM-518).
 *
 * The row is built by NG's `SegmentWidgetFactory` — the same widget the layer's
 * segment list and the annotation panel show: the ID chip in the segment's
 * colour, visibility, star, copy, colour picker. Nothing about it is
 * re-implemented here, so colour, hover highlight and the row's controls
 * behave exactly as in the NG segment list. This module only mounts it, keeps
 * it updated, and cleans up after it.
 */

import "#src/layer/segmentation/style.css";
import "#src/ui/segment_list.css";

import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import {
  bindSegmentListWidth,
  registerCallbackWhenSegmentationDisplayStateChanged,
  SegmentWidgetFactory,
} from "#src/segmentation_display_state/frontend.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";

type Factory = ReturnType<typeof SegmentWidgetFactory.make>;

// One factory per layer: it caches NG's per-layer event handlers.
const factories = new WeakMap<SegmentationDisplayState, Factory>();

function factoryFor(displayState: SegmentationDisplayState): Factory {
  let factory = factories.get(displayState);
  if (factory === undefined) {
    factory = SegmentWidgetFactory.make(
      displayState,
      /*includeUnmapped=*/ false,
    );
    factories.set(displayState, factory);
  }
  return factory;
}

/**
 * Mount NG's segment-list row for segment `id` into `parent`, kept in step
 * with the layer (colours, visibility, star, hover) until the returned
 * function removes it.
 */
export function mountSegmentListWidget(
  displayState: SegmentationDisplayState,
  parent: HTMLElement,
  id: bigint,
): () => void {
  const factory = factoryFor(displayState);
  const element = factory.get(id);
  parent.appendChild(element);

  const context = new RefCounted();
  // The ID column width NG's row layout reads, as in the NG segment list.
  context.registerDisposer(bindSegmentListWidth(displayState, parent));
  const update = context.registerCancellable(
    animationFrameDebounce(() => factory.update(element)),
  );
  registerCallbackWhenSegmentationDisplayStateChanged(
    displayState,
    context,
    update,
  );
  context.registerDisposer(
    displayState.segmentationGroupState.changed.add(update),
  );

  // NG clears the hover highlight on `mouseleave`, which never arrives when a
  // hovered row is removed (untracked from the selection, list closed), so the
  // highlight would stick in the viewer.
  let isHovered = false;
  element.addEventListener("mouseenter", () => {
    isHovered = true;
  });
  element.addEventListener("mouseleave", () => {
    isHovered = false;
  });

  return () => {
    if (isHovered) displayState.segmentSelectionState.set(null);
    context.dispose();
    element.remove();
  };
}
