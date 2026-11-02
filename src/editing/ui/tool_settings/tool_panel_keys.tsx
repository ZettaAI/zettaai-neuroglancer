/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Fragment } from "preact";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import {
  editModeShortcuts,
  effectiveEditKeybinds,
} from "#src/editing/session_hotkey_binder.js";

import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { formatShortcutKeys } from "#src/ui/key_chord_format.js";
import { SHORTCUT_SHEET_KEYS } from "#src/ui/mode_shortcuts.js";
import "#src/editing/ui/tool_settings/tool_panel_keys.css";

/** The live edit keybinds, for rows that show their own keys. */
export function useEditKeybinds(host: EditSessionHost) {
  return effectiveEditKeybinds(useWatchable(host.editKeybindOverrides));
}

/**
 * The active tool's keys at the bottom of its panel, open by default: a plain
 * list of key and what it does, in the same form as the Trace tab's. Reads the
 * live bindings, so a rebound key shows as rebound.
 */
export function ToolPanelKeys({
  host,
  toolId,
}: {
  host: EditSessionHost;
  toolId: string | undefined;
}) {
  const overrides = useWatchable(host.editKeybindOverrides);
  const shortcuts = editModeShortcuts(toolId, effectiveEditKeybinds(overrides));
  return (
    <details class="neuroglancer-tool-panel-keys" open>
      <summary>Hotkeys</summary>
      <dl>
        {shortcuts.map((shortcut) => (
          <Fragment key={shortcut.label}>
            <dt>{formatShortcutKeys(shortcut.keys, shortcut.pairKeys)}</dt>
            <dd>{shortcut.description ?? shortcut.label}</dd>
          </Fragment>
        ))}
        <dt>{formatShortcutKeys(SHORTCUT_SHEET_KEYS)}</dt>
        <dd>all shortcuts</dd>
      </dl>
    </details>
  );
}
