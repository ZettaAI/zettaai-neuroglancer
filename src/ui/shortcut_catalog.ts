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
 * The contents of the shortcut sheet: every row names a task and reads its keys
 * from the source that actually binds them, so a remapped key shows as remapped.
 */

import type { EditKeybindName } from "#src/editing/session_hotkey_binder.js";
import {
  keysForCustomAction,
  keysForCustomTool,
} from "#src/ui/custom_keybinds.js";
import { chordsForAction } from "#src/ui/key_chord_format.js";
import type { EventActionMap } from "#src/util/event_action_map.js";

export interface ShortcutRow {
  readonly label: string;
  readonly keys: readonly string[];
  /** Set when the row's key can be changed from the sheet. */
  readonly rebind?: EditKeybindName;
}

export interface ShortcutSection {
  readonly title: string;
  readonly rows: readonly ShortcutRow[];
}

const EDIT_ROWS: ReadonlyArray<[EditKeybindName, string]> = [
  ["cursor", "Cursor"],
  ["brush", "Brush"],
  ["erase", "Eraser"],
  ["fill", "Fill"],
  ["zextrap", "Z-extrapolation"],
  ["sizeDecrease", "Smaller brush"],
  ["sizeIncrease", "Larger brush"],
  ["targetValueDecrease", "Previous target value"],
  ["targetValueIncrease", "Next target value"],
  ["fillClosedPaths", "Fill closed paths on / off"],
  ["undo", "Undo"],
  ["redo", "Redo"],
  ["saveAll", "Save all"],
  ["paramPrev", "Previous setting"],
  ["paramNext", "Next setting"],
  ["paramIncrease", "Raise setting"],
  ["paramDecrease", "Lower setting"],
];

const SEGMENT_TOOL_ROWS: ReadonlyArray<[string, string]> = [
  ["calcadaMergeSegments", "Merge"],
  ["calcadaPieceSplit", "Cut"],
  ["calcadaMulticutSegments", "Multicut"],
  ["calcadaFindPath", "Find path"],
];

const SEGMENT_ACTION_ROWS: ReadonlyArray<[string, string]> = [
  ["calcada-toggle-zetta-trace", "Start a trace"],
  ["calcada-toggle-split-detection", "Split error detection"],
  ["calcada-toggle-debug-mode", "Debug overlay"],
  ["select-previous", "Previous selected segment"],
  ["select-next", "Next selected segment"],
];

const VIEW_ROWS: ReadonlyArray<[string, string]> = [
  ["z-", "Previous section"],
  ["z+", "Next section"],
  ["snap", "Snap to axes"],
  ["toggle-layout", "Switch layout"],
  ["toggle-show-slices", "Show slices in 3D"],
  ["toggle-scale-bar", "Scale bar"],
  ["toggle-axis-lines", "Axis lines"],
  ["open-command-palette", "Command palette"],
];

function keysWithAnyBinding(rows: readonly ShortcutRow[]): ShortcutRow[] {
  return rows.filter((row) => row.keys.length > 0);
}

export function buildShortcutSections(
  editKeys: Record<EditKeybindName, readonly string[]>,
  inputMaps: readonly EventActionMap[],
  sessionActive: boolean,
): ShortcutSection[] {
  // During a session its keys shadow the global ones, so a row whose every key
  // now does something else would promise the wrong thing.
  const claimedBySession = new Set(
    sessionActive ? Object.values(editKeys).flat() : [],
  );
  const reachable = (rows: readonly ShortcutRow[]) =>
    keysWithAnyBinding(rows).filter((row) =>
      row.keys.some((key) => !claimedBySession.has(key)),
    );
  const keysFromMaps = (action: string) => {
    for (const map of inputMaps) {
      const chords = chordsForAction(map, action);
      if (chords.length > 0) return chords;
    }
    return [];
  };
  return [
    {
      title: "Edit session",
      rows: EDIT_ROWS.map(([name, label]) => ({
        label,
        keys: editKeys[name],
        rebind: name,
      })),
    },
    {
      title: "Segments",
      rows: reachable([
        ...SEGMENT_TOOL_ROWS.map(([toolId, label]) => ({
          label,
          keys: keysForCustomTool(toolId),
        })),
        ...SEGMENT_ACTION_ROWS.map(([action, label]) => ({
          label,
          keys: [...keysForCustomAction(action), ...keysFromMaps(action)],
        })),
      ]),
    },
    {
      title: "View",
      rows: reachable(
        VIEW_ROWS.map(([action, label]) => ({
          label,
          keys: keysFromMaps(action),
        })),
      ),
    },
  ];
}

/** The sections narrowed to rows whose label contains the text. */
export function filterShortcutSections(
  sections: readonly ShortcutSection[],
  query: string,
): ShortcutSection[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...sections];
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) =>
        row.label.toLowerCase().includes(needle),
      ),
    }))
    .filter((section) => section.rows.length > 0);
}
