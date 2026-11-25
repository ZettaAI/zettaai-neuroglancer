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

import {
  OPEN_ENTRY_SHOWN_KEYS,
  QUICK_REGION_SHOWN_KEYS,
} from "#src/editing/idle_edit_hotkey_binder.js";
import type { EditKeybindName } from "#src/editing/session_hotkey_binder.js";
import {
  keysForCustomAction,
  keysForCustomTool,
} from "#src/ui/custom_keybinds.js";
import {
  chordsForAction,
  isMacPlatform,
  shownChords,
} from "#src/ui/key_chord_format.js";
import type { EventActionMap } from "#src/util/event_action_map.js";

export interface ShortcutRow {
  readonly label: string;
  readonly keys: readonly string[];
  /**
   * Set when the row's key can be changed from the sheet: only during a
   * session, the only place the edit keys act.
   */
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
  ["fillClosedPaths", "Fill inside on / off"],
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

/** The sheet's name for a viewer action, or the action id if it has none. */
export function viewerActionLabel(action: string): string {
  const row = [...SEGMENT_ACTION_ROWS, ...VIEW_ROWS].find(
    ([rowAction]) => rowAction === action,
  );
  return row?.[1] ?? action;
}

/**
 * Said after a rebind takes a viewer key: what the key stops doing, and that
 * this only lasts while an edit session is open.
 */
export function shadowedViewerKeyMessage(
  formattedKey: string,
  action: string,
): string {
  return `While an edit session is open, ${formattedKey} no longer does "${viewerActionLabel(action)}". Outside a session it works as before.`;
}

/** The sheet's name for an edit action ("erase" → "Eraser"). */
export function editKeybindLabel(name: EditKeybindName): string {
  return EDIT_ROWS.find(([rowName]) => rowName === name)?.[1] ?? name;
}

/**
 * What to tell the annotator after a rebind of `name` to `identifier`: which
 * edit action gave the key up and the keys it has now, and which viewer action
 * the key covers during a session. Empty when there is nothing to say.
 * `formatKey` turns an identifier into what the caller shows for it.
 */
export function rebindOutcomeMessage(
  name: EditKeybindName,
  identifier: string,
  displaced:
    | {
        readonly name: EditKeybindName;
        readonly keys: readonly string[];
        readonly swapped: boolean;
      }
    | undefined,
  shadowedAction: string | undefined,
  formatKey: (identifier: string) => string,
  mac: boolean = isMacPlatform(),
): string {
  const key = formatKey(identifier);
  const parts: string[] = [];
  if (displaced !== undefined) {
    const label = editKeybindLabel(name);
    const ownerLabel = editKeybindLabel(displaced.name);
    const ownerKeys = shownChords(displaced.keys, mac)
      .map(formatKey)
      .join(" / ");
    parts.push(
      displaced.swapped
        ? `${label} now uses ${key}. ${ownerLabel} took ${label}'s old key, ${ownerKeys}.`
        : `${label} now uses ${key}. ${ownerLabel} no longer uses ${key}; it still works with ${ownerKeys}.`,
    );
  }
  if (shadowedAction !== undefined) {
    parts.push(shadowedViewerKeyMessage(key, shadowedAction));
  }
  return parts.join(" ");
}

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
      rows: [
        // Only without a session: inside one, Ctrl+E is the eraser.
        ...(sessionActive
          ? []
          : [
              { label: "Open edit session", keys: OPEN_ENTRY_SHOWN_KEYS },
              { label: "Draw an edit region", keys: QUICK_REGION_SHOWN_KEYS },
            ]),
        ...EDIT_ROWS.map(([name, label]) => ({
          label,
          keys: editKeys[name],
          ...(sessionActive ? { rebind: name } : {}),
        })),
      ],
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
