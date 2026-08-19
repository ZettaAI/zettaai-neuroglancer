/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession } from "@zettaai/edit-session";
import { useCallback } from "preact/hooks";

import { radiusToSize, sizeToRadius } from "#src/editing/brush_size_presets.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { BrushSizeField } from "#src/editing/ui/tool_settings/brush_size_field.js";
import { PaintingTargetPicker } from "#src/editing/ui/tool_settings/painting_target_picker.js";
import {
  PARAM_IDS,
  sizeDescriptor,
  useParamFocus,
  useParamSelection,
  usePublishParams,
  useTargetParamDescriptors,
} from "#src/editing/ui/tool_settings/param_descriptors.js";

/**
 * Eraser panel (TM-294 simplification): Target layer + resolution + Size
 * slider with editable numeric input. Drops the legacy preset row, the
 * "Erase value" display, and the Advanced section — the eraser always
 * writes the implicit `eraseValue` (0n) and never uses a mask.
 */
export function PaintingEraser({
  host,
}: {
  session: EditSession;
  host: EditSessionHost;
}) {
  const painting = host.painting!.state;
  const subscribe = useCallback(
    (h: () => void) => painting.changed.add(h),
    [painting],
  );
  useEvent(subscribe);
  const state = painting.getState();

  const commitSize = (size: number) =>
    painting.patchState({ radius: sizeToRadius(size) });

  const size = radiusToSize(state.radius);

  const selectedId = useParamSelection(host);
  const selectParam = useParamFocus(host);
  const targetDescriptors = useTargetParamDescriptors(host);
  usePublishParams(host, [...targetDescriptors, sizeDescriptor(painting)]);

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-eraser-panel">
      <PaintingTargetPicker host={host} />
      <BrushSizeField
        size={size}
        hint="Eraser diameter in voxels at the target resolution. Larger sizes clear a wider stroke."
        onCommit={commitSize}
        highlighted={selectedId === PARAM_IDS.size}
        onSelect={() => selectParam(PARAM_IDS.size)}
      />
    </div>
  );
}
