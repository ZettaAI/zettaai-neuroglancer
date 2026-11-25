/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Info } from "lucide-preact";

import { useContext } from "preact/hooks";

import { EditKeybindsContext } from "#src/editing/ui/tool_settings/tool_panel_keys.js";
import {
  formatShortcutKeys,
  shortcutAttributes,
} from "#src/ui/key_chord_format.js";
import type { ModeShortcut } from "#src/ui/mode_shortcuts.js";

/**
 * A tool-panel parameter label with an inline help marker. The marker carries
 * a `data-tooltip` hint surfaced by the shared fast-tooltip mechanism (see
 * fast_tooltip.ts), so hovering the ⓘ explains what the parameter does.
 *
 * Drop-in replacement for a bare `<label>` inside `.neuroglancer-tool-panel-row`.
 */
export function ParamLabel({
  text,
  hint,
  shortcut,
  setting = false,
}: {
  text: string;
  hint: string;
  /** The parameter's own keys, shown in the hint as key caps beside its name. */
  shortcut?: ModeShortcut;
  /**
   * The row is one of the settings the Ctrl/Option+Arrow keys walk through: the
   * hint then says how to reach and change it, and shows the change keys when
   * the row has none of its own.
   */
  setting?: boolean;
}) {
  const editKeys = useContext(EditKeybindsContext);
  const settingKeys =
    setting && editKeys !== undefined
      ? {
          choose: formatShortcutKeys(editKeys.paramPrev, editKeys.paramNext),
          change: formatShortcutKeys(
            editKeys.paramDecrease,
            editKeys.paramIncrease,
          ),
          shortcut: {
            keys: editKeys.paramDecrease,
            pairKeys: editKeys.paramIncrease,
            label: text,
          },
        }
      : undefined;
  const shownKeys = shortcut ?? settingKeys?.shortcut;
  const howToReach =
    settingKeys === undefined
      ? ""
      : `\nChoose it with ${settingKeys.choose}, change it with ${settingKeys.change}.`;
  const keyAttributes =
    shownKeys === undefined
      ? {}
      : shortcutAttributes(shownKeys.keys, shownKeys.pairKeys);
  return (
    <label>
      {text}
      <span
        class="neuroglancer-param-hint"
        data-tooltip={
          shownKeys === undefined ? hint : `${text}\n${hint}${howToReach}`
        }
        {...keyAttributes}
        aria-hidden="true"
      >
        <Info size={13} />
      </span>
    </label>
  );
}
