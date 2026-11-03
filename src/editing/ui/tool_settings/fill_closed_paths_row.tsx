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
import type { ModeShortcut } from "#src/ui/mode_shortcuts.js";

/** The brush switch that fills the inside of a closed stroke (TM-268). */
export function FillClosedPathsRow({
  painting,
  shortcut,
}: {
  painting: PaintingState;
  /** The key that switches it, shown in the hint. */
  shortcut?: ModeShortcut;
}) {
  return (
    <div class="neuroglancer-tool-panel-row">
      <ParamLabel
        text="Fill closed paths"
        hint="When a stroke closes on itself, also paints the area inside it, replacing any segments there. Undo removes the stroke and the fill together."
        shortcut={shortcut}
      />
      <ToggleSwitch
        checked={painting.getState().fillClosedPaths}
        ariaLabel="Fill closed paths"
        onChange={(fillClosedPaths) => painting.patchState({ fillClosedPaths })}
      />
    </div>
  );
}
