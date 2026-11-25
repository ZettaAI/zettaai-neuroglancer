/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { PaintingState } from "#src/editing/tool_runtimes/painting_tools.js";
import { ToggleSwitch } from "#src/editing/ui/toggle_switch.js";
import { ParamLabel } from "#src/editing/ui/tool_settings/param_label.js";

/**
 * The brush / fill switch that selects the painted segment (TM-490). Shared
 * painting state, so both panels show the same setting.
 */
export function PaintedSegmentAutoSelectRow({
  painting,
}: {
  painting: PaintingState;
}) {
  return (
    <div class="neuroglancer-tool-panel-row">
      <ParamLabel
        text="Auto-select segment"
        hint="Selects the segment you paint, so it shows in 2D and 3D without a double-click. The eraser never selects."
      />
      <ToggleSwitch
        checked={painting.getState().autoSelectPaintedSegment}
        ariaLabel="Auto-select segment"
        onChange={(autoSelectPaintedSegment) =>
          painting.patchState({ autoSelectPaintedSegment })
        }
      />
    </div>
  );
}
