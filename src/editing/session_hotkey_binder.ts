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
 * @file Session-scoped keyboard shortcut layer for an active edit session.
 *
 * Per `docs/edit-session-integration/architecture/05-tools-and-cursor.md`
 * § "Tool activation hotkeys (v1)" and § "Routing mechanism", an active edit
 * session installs a session-scoped binding layer that overrides
 * neuroglancer's global hotkeys for the session's duration.
 *
 * Routing strategy (see also `07-data-flow.md` § H):
 *
 * Neuroglancer's global `KeyboardEventBinder` (`src/viewer.ts:1041`) is
 * permanently attached to `viewer.element` and consults
 * `viewer.inputEventMap`, which is an `EventActionMap`. `EventActionMap`
 * extends `HierarchicalMap` (`src/util/hierarchical_map.ts:45`) and supports
 * priority-based parent maps via `addParent(parent, priority)`. When
 * `priority > 0`, the parent's bindings take precedence over direct
 * bindings (see `HierarchicalMap.get`,
 * `src/util/hierarchical_map.ts:132`).
 *
 * We therefore install our session-scoped `EventActionMap` as a
 * high-priority parent of `viewer.inputEventMap`. The architecture doc's
 * conjectural `viewer.keyboardBinder.pushMap(...)` API does not exist
 * (`KeyboardEventBinder` itself has no stack — `src/util/keyboard_bindings.ts`),
 * but `addParent` is the canonical neuroglancer "layered binder" idiom and
 * is already used to compose default bindings
 * (`src/ui/default_input_event_bindings.ts:72-78`).
 *
 * Action listeners are registered on `viewer.element` (the same target the
 * global binder dispatches to via `dispatchEventAction`,
 * `src/util/event_action_map.ts:421`). On dispose, the parent linkage and
 * all listeners are removed; the global bindings (e.g., any default
 * `Ctrl+Z`) return to normal.
 */

import { radiusToSize, sizeToRadius } from "#src/editing/brush_size_presets.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { HeldKeyTracker } from "#src/editing/held_key_tracker.js";
import { keyboardEventToIdentifier } from "#src/editing/keybind_event.js";
import {
  accelStepsPerSecond,
  nextPresetSize,
} from "#src/editing/painting_hotkey_math.js";
import {
  ParamStatusOverlay,
  type StatusTint,
} from "#src/editing/param_status_overlay.js";
import { isFieldKeyForSession } from "#src/editing/tool_panel_field_keys.js";
import type { PaintingState } from "#src/editing/tool_runtimes/painting_tools.js";
import type { PaintParamCursor } from "#src/editing/tool_runtimes/param_cursor.js";
import type { EditKeybindOverrides } from "#src/editing/tooling/tooling_persist.js";
import {
  PARAM_IDS,
  valueDescriptor,
} from "#src/editing/ui/tool_settings/param_descriptors.js";
import {
  getEditSessionKeybinds,
  type EditSessionKeybinds,
} from "#src/ui/custom_keybinds.js";
import { isMacPlatform } from "#src/ui/key_chord_format.js";
import {
  modeShortcuts,
  SHORTCUT_SHEET_KEYS,
  type ModeShortcut,
} from "#src/ui/mode_shortcuts.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

// Priority must be > 0 so the session layer overrides direct bindings on
// `viewer.inputEventMap` (e.g. neuroglancer's global `keyb` → "toggle-scale-bar"
// in `src/ui/default_input_event_bindings.ts:28`).
const SESSION_HOTKEY_PRIORITY = 100;

/** How long the target value readout, with its colour, stays up. */
const TARGET_VALUE_READOUT_MS = 2000;

export { isMacPlatform };

// Centralised so the action ids stay in sync between the action map and the
// action-listener registrations below. Mirrors the v1 hotkey table in
// `docs/edit-session-integration/architecture/05-tools-and-cursor.md`.
const ACTION_IDS = {
  toolBrush: "edit-session-tool-brush",
  toolErase: "edit-session-tool-erase",
  toolFill: "edit-session-tool-fill",
  toolZExtrap: "edit-session-tool-zextrap",
  toolCorrespondence: "edit-session-tool-correspondence",
  cursorMode: "edit-session-cursor-mode",
  undo: "edit-session-undo",
  redo: "edit-session-redo",
  saveAll: "edit-session-save-all",
  exitTool: "edit-session-exit-tool",
  // `+` / `-` — step brush *size* through the preset cycle.
  sizeDecr: "edit-session-size-decr",
  sizeIncr: "edit-session-size-incr",
  // `{` / `}` — step the target value (the segment being painted).
  targetValueDecr: "edit-session-target-value-decr",
  targetValueIncr: "edit-session-target-value-incr",
  // Brush: fill the inside of a closed stroke on / off (TM-268).
  toggleFillClosedPaths: "edit-session-toggle-fill-closed-paths",
  // Ctrl+Left / Ctrl+Right (Option+Arrow on macOS) — move the parameter
  // selection cursor through the active tool panel's enabled controls (TM-337).
  paramPrev: "edit-session-param-prev",
  paramNext: "edit-session-param-next",
  // Ctrl+Up / Ctrl+Down (Option+Arrow on macOS) — increment / decrement the
  // selected parameter, with hold-to-accelerate for numeric params.
  paramIncr: "edit-session-param-incr",
  paramDecr: "edit-session-param-decr",
} as const;

/**
 * User-configurable edit hotkeys (TM-315). Friendly name → default key event
 * identifier(s). Overridable per-deployment via the `editSession` section of
 * `config/custom-keybinds.json`; merged in `mergeEditKeybinds`. The fixed
 * binding (escape) is NOT user-configurable and is added directly in the
 * action map.
 */
export type EditKeybindName =
  | "brush"
  | "erase"
  | "fill"
  | "zextrap"
  | "cursor"
  | "undo"
  | "redo"
  | "saveAll"
  | "sizeDecrease"
  | "sizeIncrease"
  | "targetValueDecrease"
  | "targetValueIncrease"
  | "fillClosedPaths"
  | "paramPrev"
  | "paramNext"
  | "paramIncrease"
  | "paramDecrease";

/**
 * Default keys for the Ctrl+Arrow parameter scheme (TM-337), chosen per
 * platform: macOS reserves `Ctrl+Arrow` for Spaces / Mission Control at the
 * window-server level — the browser never receives those events and
 * `preventDefault` can't reclaim them — so macOS uses `Option(Alt)+Arrow`
 * instead, which the OS leaves free. Windows/Linux keep `Ctrl+Arrow` (matches
 * the ticket; no system conflict there). Pure + exported so the binder and the
 * unit tests agree on the mapping. Still user-overridable like the other binds.
 */
export function paramArrowDefaults(mac: boolean): {
  paramPrev: readonly string[];
  paramNext: readonly string[];
  paramIncrease: readonly string[];
  paramDecrease: readonly string[];
} {
  const mod = mac ? "alt" : "control";
  return {
    paramPrev: [`${mod}+arrowleft`],
    paramNext: [`${mod}+arrowright`],
    paramIncrease: [`${mod}+arrowup`],
    paramDecrease: [`${mod}+arrowdown`],
  };
}

// Tools take Ctrl, as before TM-517: plain letters belong to neuroglancer in the
// data panels (E / R rotate the view, B the scale bar, V the default
// annotations), and a session must not take them away. Fill is Ctrl+G, not
// Ctrl+F, which is the browser's Find.
const DEFAULT_EDIT_KEYBINDS: Record<EditKeybindName, readonly string[]> = {
  brush: ["control+keyb"],
  erase: ["control+keye"],
  fill: ["control+keyg"],
  zextrap: ["control+keyx"],
  cursor: ["control+keyv"],
  undo: ["control+keyz", "meta+keyz"],
  redo: ["control+shift+keyz", "meta+shift+keyz"],
  saveAll: ["control+keys", "meta+keys"],
  sizeDecrease: ["minus", "numpadsubtract"],
  // The shifted key comes first because it is the one shown: "+", not "=".
  sizeIncrease: ["shift+equal", "equal", "numpadadd"],
  // Shifted, because plain `[` / `]` walk the annotations during a session
  // (TM-439); these stay on the same two keys the old portal used.
  targetValueDecrease: ["shift+bracketleft"],
  targetValueIncrease: ["shift+bracketright"],
  // "Fill Inside": F is Find Path's, and I is free in every map.
  fillClosedPaths: ["keyi"],
  ...paramArrowDefaults(isMacPlatform()),
};

const EDIT_KEYBIND_ACTION: Record<EditKeybindName, string> = {
  brush: ACTION_IDS.toolBrush,
  erase: ACTION_IDS.toolErase,
  fill: ACTION_IDS.toolFill,
  zextrap: ACTION_IDS.toolZExtrap,
  cursor: ACTION_IDS.cursorMode,
  undo: ACTION_IDS.undo,
  redo: ACTION_IDS.redo,
  saveAll: ACTION_IDS.saveAll,
  sizeDecrease: ACTION_IDS.sizeDecr,
  sizeIncrease: ACTION_IDS.sizeIncr,
  targetValueDecrease: ACTION_IDS.targetValueDecr,
  targetValueIncrease: ACTION_IDS.targetValueIncr,
  fillClosedPaths: ACTION_IDS.toggleFillClosedPaths,
  paramPrev: ACTION_IDS.paramPrev,
  paramNext: ACTION_IDS.paramNext,
  paramIncrease: ACTION_IDS.paramIncr,
  paramDecrease: ACTION_IDS.paramDecr,
};

/**
 * Build the `key → action` map for the session input layer: defaults overridden
 * by `overrides` (the `editSession` section of `custom-keybinds.json`), plus the
 * fixed (non-configurable) bindings. Last write wins on key collisions. Pure +
 * exported for unit testing.
 */
export function mergeEditKeybinds(
  overrides: EditSessionKeybinds | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(EDIT_KEYBIND_ACTION) as EditKeybindName[]) {
    const override = overrides?.[name];
    const keys =
      override !== undefined
        ? Array.isArray(override)
          ? override
          : [override]
        : DEFAULT_EDIT_KEYBINDS[name];
    for (const key of keys) {
      out[key] = EDIT_KEYBIND_ACTION[name];
    }
  }
  // Fixed binding — not user-configurable.
  out["escape"] = ACTION_IDS.exitTool;
  return out;
}

/**
 * The configurable edit-hotkey action names, in display order. Exported so the
 * topbar rebind UI can iterate them without re-declaring the list.
 */
export const EDIT_KEYBIND_NAMES = Object.keys(
  EDIT_KEYBIND_ACTION,
) as EditKeybindName[];

/**
 * Resolve the EFFECTIVE key identifier(s) bound to each configurable action,
 * applying the same precedence the binder uses: built-in defaults ←
 * `custom-keybinds.json` ← per-user runtime overrides. A whole-list replace per
 * action name. Pure + exported so the UI can display the live binding and the
 * behaviour stays in lock-step with {@link buildEditActionBindings}.
 */
export function effectiveEditKeybinds(
  perUser: EditKeybindOverrides | undefined,
): Record<EditKeybindName, readonly string[]> {
  const config = getEditSessionKeybinds();
  const out = {} as Record<EditKeybindName, readonly string[]>;
  for (const name of EDIT_KEYBIND_NAMES) {
    const chosen =
      perUser?.[name] ?? config?.[name] ?? DEFAULT_EDIT_KEYBINDS[name];
    out[name] = Array.isArray(chosen) ? chosen : [chosen];
  }
  return out;
}

/**
 * Resolve the live `key → action` map from the three layers, lowest priority
 * first: built-in defaults ← `custom-keybinds.json` `editSession` overrides ←
 * per-user runtime overrides (`host.editKeybindOverrides`). A per-user entry
 * replaces the whole key list for that action name. `mergeEditKeybinds` folds
 * in the defaults and the fixed bindings.
 */
function buildEditActionBindings(
  perUser: EditKeybindOverrides | undefined,
): Record<string, string> {
  const config = getEditSessionKeybinds();
  const merged: { [name: string]: string | readonly string[] } = {
    ...config,
  };
  if (perUser !== undefined) {
    for (const [name, keys] of Object.entries(perUser)) {
      merged[name] = keys;
    }
  }
  return mergeEditKeybinds(merged);
}

// Library tool ids (see `node_modules/@zettaai/edit-session/dist/index.d.mts`
// lines 1178, 1213, 1425, 1568, and 1148 for the `StrokeTool` toolId values).
const TOOL_ID_BRUSH = "painting.brush";
const TOOL_ID_ERASE = "painting.erase";
const TOOL_ID_FILL = "painting.fill";
const TOOL_ID_Z_EXTRAP = "z-extrapolation";
const TOOL_ID_CORRESPONDENCE = "correspondence";

// Keys a rebind may never take: H opens the shortcut sheet, and plain [ / ]
// walk the annotations during a session (TM-439).
const RESERVED_KEYS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    SHORTCUT_SHEET_KEYS.map((key) => [key, "show all shortcuts"]),
  ),
  bracketleft: "previous annotation",
  bracketright: "next annotation",
};

/**
 * What already uses `identifier`: another edit action, a reserved key, or an
 * action the viewer's input maps bind (calcada tools, Trace, view keys). The
 * session's own map is a parent of those maps, so its entries are skipped. A
 * rebind that would take the key is refused rather than letting it shadow the
 * other binding for the whole session.
 */
export function findEditKeybindConflict(
  name: EditKeybindName,
  identifier: string,
  effective: Record<EditKeybindName, readonly string[]>,
  inputMaps: readonly EventActionMap[] = [],
): string | undefined {
  if (identifier === "escape") return "exit";
  const editOwner = EDIT_KEYBIND_NAMES.find(
    (other) => other !== name && effective[other].includes(identifier),
  );
  if (editOwner !== undefined) return editOwner;
  const reserved = RESERVED_KEYS[identifier];
  if (reserved !== undefined) return reserved;
  return inputMapOwner(inputMaps, identifier);
}

function inputMapOwner(
  inputMaps: readonly EventActionMap[],
  identifier: string,
): string | undefined {
  // Normalised through a probe map, the same way the maps store their keys.
  const probe = EventActionMap.fromObject({ [identifier]: "probe" });
  for (const [normalized] of probe.entries()) {
    for (const map of inputMaps) {
      const action = map.get(normalized)?.action;
      if (action !== undefined && !action.startsWith("edit-session-")) {
        return action;
      }
    }
  }
  return undefined;
}

const EDIT_MODE_PRIORITY = 1;
const EDIT_MODE_ID = "edit-session";
const TARGET_VALUE_PARAM_ID = PARAM_IDS.value;

/**
 * The keys worth keeping on screen: the tools themselves on the plain cursor,
 * and what the tool's settings need once one is active. Pure for tests.
 */
export function editModeShortcuts(
  toolId: string | undefined,
  keys: Record<EditKeybindName, readonly string[]>,
): ModeShortcut[] {
  const history: ModeShortcut[] = [
    { keys: keys.undo, label: "Undo", description: "undo the last edit" },
    { keys: keys.redo, label: "Redo", description: "redo the undone edit" },
  ];
  const save: ModeShortcut = {
    keys: keys.saveAll,
    label: "Save all",
    description: "save all edited layers",
  };
  if (toolId === undefined) {
    return [
      { keys: keys.brush, label: "Brush", description: "brush" },
      { keys: keys.erase, label: "Eraser", description: "eraser" },
      { keys: keys.fill, label: "Fill", description: "fill" },
      {
        keys: keys.zextrap,
        label: "Z-extrapolation",
        description: "z-extrapolation",
      },
      ...history,
      save,
    ];
  }
  const shortcuts: ModeShortcut[] = [];
  if (toolId === TOOL_ID_BRUSH || toolId === TOOL_ID_ERASE) {
    shortcuts.push({
      keys: keys.sizeDecrease,
      pairKeys: keys.sizeIncrease,
      label: "Size",
      description: "smaller / larger brush",
    });
  }
  if (toolId === TOOL_ID_BRUSH) {
    shortcuts.push({
      keys: keys.fillClosedPaths,
      label: "Fill inside",
      description: "fill inside on / off",
      detailOnly: true,
    });
  }
  if (toolId === TOOL_ID_BRUSH || toolId === TOOL_ID_FILL) {
    shortcuts.push({
      keys: keys.targetValueDecrease,
      pairKeys: keys.targetValueIncrease,
      label: "Target value",
      description: "previous / next target value",
      detailOnly: true,
    });
  }
  if (isPaintLikeToolId(toolId)) {
    shortcuts.push(
      {
        keys: keys.paramPrev,
        pairKeys: keys.paramNext,
        label: "Choose setting",
        description: "move between the settings",
        detailOnly: true,
      },
      {
        keys: keys.paramDecrease,
        pairKeys: keys.paramIncrease,
        label: "Change setting",
        description: "change the selected setting",
        detailOnly: true,
      },
    );
  }
  // Save stays in the panel's list: the strip keeps to one line over the data.
  shortcuts.push(
    ...history,
    { ...save, detailOnly: true },
    {
      keys: ["escape"],
      label: "Cursor",
      description: "back to the cursor",
    },
  );
  return shortcuts;
}

const EDIT_TOOL_TITLE: Record<string, string> = {
  [TOOL_ID_BRUSH]: "Brush",
  [TOOL_ID_ERASE]: "Eraser",
  [TOOL_ID_FILL]: "Fill",
  [TOOL_ID_Z_EXTRAP]: "Z-extrapolation",
  [TOOL_ID_CORRESPONDENCE]: "Correspondence",
};

/**
 * Installs a session-scoped keyboard shortcut layer for the duration of an
 * active `EditSession`. Constructed by `EditSessionHost` on session-open
 * and disposed on session-end; the host owns the lifecycle.
 */
export class EditSessionHotkeyBinder extends RefCounted {
  // Held-key state for the Ctrl+Arrow hold-to-accelerate ramp (see
  // `held_key_tracker.ts`): tracks the chord modifier + arrow key on release.
  private readonly tracker: HeldKeyTracker;

  // Center-screen readout for the Ctrl+Arrow parameter scheme (TM-337).
  private readonly statusOverlay: ParamStatusOverlay;
  // Active hold-to-accelerate session for Ctrl+Up / Ctrl+Down, or null when no
  // arrow is held. `accum` carries fractional steps between animation frames.
  private ramp: {
    dir: number;
    arrowCode: string;
    startMs: number;
    lastMs: number;
    accum: number;
    rafId: number;
  } | null = null;

  // The viewer whose `inputEventMap` we parent our session layer onto. Stored
  // so `rebuildActionMap` can re-attach after a runtime rebind.
  private viewer!: Viewer;
  // Detaches the currently-installed session action map; replaced on each
  // rebuild and called on dispose.
  private detachActionMap: (() => void) | undefined;

  constructor(
    private readonly host: EditSessionHost,
    viewer: Viewer,
  ) {
    super();
    this.tracker = this.registerDisposer(new HeldKeyTracker(viewer.element));
    this.statusOverlay = this.registerDisposer(new ParamStatusOverlay());
    this.registerDisposer(() => this.stopRamp());

    // Build the session's `EventActionMap` from the configurable edit keybinds
    // (defaults + `custom-keybinds.json` `editSession` overrides + per-user
    // runtime rebinds) plus the fixed bindings (TM-315). Keys are bare event
    // identifiers (no `key:` phase prefix — `parseEventIdentifier` only accepts
    // `at` / `bubble` phases). Edit hotkeys are Ctrl-prefixed by default (avoid
    // accidental firing while typing + no global conflict); bracket/size keys
    // stay unprefixed but are session-scoped so they don't shadow defaults
    // outside a session.
    //
    // The map is rebuilt live when the user rebinds a hotkey: we detach the old
    // parent and install a freshly built one. The action LISTENERS below are
    // keyed by action id (not by key), so they survive a rebuild untouched —
    // only the key→action routing changes.
    this.viewer = viewer;
    this.rebuildActionMap(host.editKeybindOverrides.value);
    this.registerDisposer(
      host.editKeybindOverrides.changed.add(() => {
        this.rebuildActionMap(host.editKeybindOverrides.value);
      }),
    );
    this.registerDisposer(() => {
      if (this.detachActionMap !== undefined) {
        try {
          this.detachActionMap();
        } catch {
          // best-effort detach during disposal
        }
        this.detachActionMap = undefined;
      }
    });

    // Camera-pan navigation maps. Swapped based on the active tool:
    //
    // - `paintNavMap` — while brush/eraser/fill is active. Plain left-click
    //   must NOT pan (otherwise click+drag would pan instead of paint), so
    //   `at:mousedown0` is shadowed by a no-op action (the synthesized
    //   `mousedown` itself still fires; Chrome only suppresses subsequent
    //   `mousemove` events when `preventDefault` is called on the upstream
    //   `pointerdown`). Ctrl/Cmd+left-click+drag pans via the existing
    //   `translate-via-mouse-drag` action.
    //
    // - `cursorNavMap` — while no tool / a non-paint tool is active. It is
    //   empty so every native neuroglancer binding falls through unchanged:
    //   plain click+drag pans via the default `translate-via-mouse-drag`, and
    //   `Ctrl+click` creates an annotation via the default
    //   `at:control+mousedown0 → annotate` binding (from
    //   `getDefaultRenderedDataPanelBindings`). Native shortcuts are only
    //   shadowed while a paint-like tool is active (see `paintNavMap`).
    const ctrlMetaPanEntries = {
      "at:control+mousedown0": {
        action: "translate-via-mouse-drag",
        stopPropagation: true,
      },
      "at:meta+mousedown0": {
        action: "translate-via-mouse-drag",
        stopPropagation: true,
      },
    } as const;
    const paintNavMap = EventActionMap.fromObject({
      "at:mousedown0": {
        action: "edit-session-noop-mousedown",
        stopPropagation: true,
      },
      ...ctrlMetaPanEntries,
    });
    paintNavMap.label = "Edit session navigation (paint)";
    const cursorNavMap = EventActionMap.fromObject({});
    cursorNavMap.label = "Edit session navigation (cursor)";

    let detachNav: (() => void) | undefined;
    const applyNavMode = (toolId: string | undefined) => {
      if (detachNav !== undefined) {
        try {
          detachNav();
        } catch {
          // best-effort detach
        }
        detachNav = undefined;
      }
      const map = isPaintLikeToolId(toolId) ? paintNavMap : cursorNavMap;
      const detachSlice = viewer.inputEventBindings.sliceView.addParent(
        map,
        SESSION_HOTKEY_PRIORITY,
      );
      const detachPerspective =
        viewer.inputEventBindings.perspectiveView.addParent(
          map,
          SESSION_HOTKEY_PRIORITY,
        );
      detachNav = () => {
        detachSlice();
        detachPerspective();
      };
    };
    // Active-tool selection is consumer-owned (TM-315): drive nav mode off the
    // host's `activeToolId` watchable instead of the removed library event.
    applyNavMode(host.activeToolId.value);
    this.registerDisposer(
      host.activeToolId.changed.add(() =>
        applyNavMode(host.activeToolId.value),
      ),
    );
    this.registerDisposer(() => {
      if (detachNav !== undefined) {
        try {
          detachNav();
        } catch {
          // best-effort detach during disposal
        }
        detachNav = undefined;
      }
    });

    // Keep the strip over the viewer in step with the active tool.
    let withdrawMode: (() => void) | undefined;
    const publishMode = () => {
      withdrawMode?.();
      withdrawMode = undefined;
      const toolId = host.activeToolId.value;
      withdrawMode = modeShortcuts.publish({
        id: EDIT_MODE_ID,
        title:
          toolId === undefined
            ? "Edit session"
            : (EDIT_TOOL_TITLE[toolId] ?? "Edit"),
        priority: EDIT_MODE_PRIORITY,
        shortcuts: editModeShortcuts(
          toolId,
          effectiveEditKeybinds(host.editKeybindOverrides.value),
        ),
      });
    };
    publishMode();
    this.registerDisposer(host.activeToolId.changed.add(publishMode));
    this.registerDisposer(host.editKeybindOverrides.changed.add(publishMode));
    this.registerDisposer(() => withdrawMode?.());

    const target = viewer.element;

    // A tool panel field keeps the keys it cannot type from going dead: the
    // field is committed (blur) and the key runs its session action.
    this.registerEventListener(
      target,
      "keydown",
      (event: KeyboardEvent) => {
        if (!isFieldKeyForSession(event.target, event.key, event)) return;
        // A Trace or other mode above the session owns its keys; leave them be.
        if (modeShortcuts.current?.id !== EDIT_MODE_ID) return;
        const identifier = keyboardEventToIdentifier(event);
        if (identifier === undefined) return;
        const action = buildEditActionBindings(host.editKeybindOverrides.value)[
          identifier
        ];
        if (action === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        (event.target as HTMLElement).blur();
        target.dispatchEvent(
          new CustomEvent(`action:${action}`, {
            bubbles: true,
            cancelable: true,
            detail: event,
          }),
        );
      },
      { capture: true },
    );

    const activateTool = (toolId: string) => {
      // Route through host.selectTool so hotkey activation keeps tool-panel
      // visibility in sync (see TM-294 rework: per-tool panel mounts).
      host.selectTool(toolId);
    };

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolBrush, () => {
        activateTool(TOOL_ID_BRUSH);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolErase, () => {
        activateTool(TOOL_ID_ERASE);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolFill, () => {
        activateTool(TOOL_ID_FILL);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolZExtrap, () => {
        activateTool(TOOL_ID_Z_EXTRAP);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolCorrespondence, () => {
        activateTool(TOOL_ID_CORRESPONDENCE);
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.saveAll, () => {
        host.requestSaveAll.dispatch();
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.undo, (event) => {
        const session = host.activeSession.value;
        if (session === undefined) return;
        event.stopPropagation();
        if (host.refuseWhilePainting()) return;
        void session.undo().catch((err) => {
          host.logger.warn(
            "session",
            `Undo failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.redo, (event) => {
        const session = host.activeSession.value;
        if (session === undefined) return;
        event.stopPropagation();
        if (host.refuseWhilePainting()) return;
        void session.redo().catch((err) => {
          host.logger.warn(
            "session",
            `Redo failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }),
    );

    const clearActiveTool = (event: Event) => {
      if (host.activeSession.value === undefined) return;
      event.stopPropagation();
      // Route through host.selectTool so Escape / Ctrl+V also closes the
      // per-tool panels (TM-294 rework).
      host.selectTool(undefined);
    };
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.exitTool, clearActiveTool),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.cursorMode, clearActiveTool),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.sizeDecr, () => {
        this.stepBrushSize(-1);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.sizeIncr, () => {
        this.stepBrushSize(+1);
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.targetValueDecr, () => {
        this.stepTargetValue(-1);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.targetValueIncr, () => {
        this.stepTargetValue(+1);
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toggleFillClosedPaths, () => {
        this.toggleFillClosedPaths();
      }),
    );

    // Ctrl+Arrow parameter scheme (TM-337; Option+Arrow on macOS). Left/Right
    // move the selection cursor through the active panel's enabled parameters;
    // Up/Down nudge the selected one (hold to accelerate for numeric params).
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.paramPrev, (event) => {
        if (this.moveParam(-1)) event.stopPropagation();
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.paramNext, (event) => {
        if (this.moveParam(+1)) event.stopPropagation();
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.paramIncr, (event) => {
        if (this.startParamRamp(+1, "arrowup")) event.stopPropagation();
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.paramDecr, (event) => {
        if (this.startParamRamp(-1, "arrowdown")) event.stopPropagation();
      }),
    );
  }

  /**
   * (Re)build the session-scoped `EventActionMap` from the current keybind
   * layers and install it as a high-priority parent of the viewer's input map,
   * detaching any previously-installed one. Called once at construction and
   * again whenever the user rebinds a hotkey at runtime.
   */
  private rebuildActionMap(overrides: EditKeybindOverrides | undefined): void {
    if (this.detachActionMap !== undefined) {
      try {
        this.detachActionMap();
      } catch {
        // best-effort detach of the previous map
      }
      this.detachActionMap = undefined;
    }
    const actionMap = EventActionMap.fromObject(
      buildEditActionBindings(overrides),
    );
    actionMap.label = "Edit session";
    // Installed on the panel maps too: a focused data panel handles a key before
    // the viewer sees it, so `keye` would otherwise rotate instead of erase.
    const { inputEventMap, inputEventBindings } = this.viewer;
    const detachers = [
      inputEventMap,
      inputEventBindings.sliceView,
      inputEventBindings.perspectiveView,
    ].map((map) => map.addParent(actionMap, SESSION_HOTKEY_PRIORITY));
    this.detachActionMap = () => {
      for (const detach of detachers) {
        try {
          detach();
        } catch {
          // best-effort: one failed detach must not keep the others attached
        }
      }
    };
  }

  // -- Painting adjustments -------------------------------------------------

  /** Returns the shared painting state, or `undefined` if unavailable. */
  private getPainting(): PaintingState | undefined {
    return this.host.painting?.state;
  }

  /** `+` / `-`: step brush size through the preset cycle (brush + eraser). */
  private stepBrushSize(dir: number): void {
    const activeId = this.host.activeToolId.value;
    if (activeId !== TOOL_ID_BRUSH && activeId !== TOOL_ID_ERASE) return;
    const painting = this.getPainting();
    if (painting === undefined) return;
    const size = radiusToSize(painting.getState().radius);
    const nextSize = nextPresetSize(size, dir);
    if (nextSize === size) return;
    painting.patchState({ radius: sizeToRadius(nextSize) });
  }

  /** `I`: the brush's "Fill inside" switch, read back where it shows. */
  private toggleFillClosedPaths(): void {
    if (this.host.activeToolId.value !== TOOL_ID_BRUSH) return;
    const painting = this.getPainting();
    if (painting === undefined) return;
    const fillClosedPaths = !painting.getState().fillClosedPaths;
    painting.patchState({ fillClosedPaths });
    this.statusOverlay.show(`Fill inside: ${fillClosedPaths ? "on" : "off"}`);
  }

  /**
   * Step the target value. The panel's own parameter is used when it is open:
   * it already knows the layer's voxel type and clamps to it. A closed panel
   * publishes nothing, so the key then builds the same parameter after reading
   * the voxel type itself, rather than going dead.
   */
  private stepTargetValue(direction: number): void {
    const activeId = this.host.activeToolId.value;
    if (activeId !== TOOL_ID_BRUSH && activeId !== TOOL_ID_FILL) return;
    const painting = this.getPainting();
    if (painting === undefined) return;
    const published = this.getCursor()
      ?.getDescriptors()
      .find((descriptor) => descriptor.id === TARGET_VALUE_PARAM_ID);
    if (published !== undefined) {
      this.applyTargetValueStep(published, direction);
      return;
    }
    const { targetLayerId } = painting.getState();
    void this.host.layerMetadataSource
      .resolve(targetLayerId)
      .then((metadata) => metadata.voxelDataType)
      .catch(() => undefined)
      .then((voxelType) => {
        if (this.wasDisposed) return;
        this.applyTargetValueStep(
          valueDescriptor(painting, voxelType),
          direction,
        );
      });
  }

  private applyTargetValueStep(
    value: {
      adjust(dir: number, magnitude: number): void;
      label: string;
      format(): string;
    },
    direction: number,
  ): void {
    value.adjust(direction, 1);
    this.statusOverlay.show(`${value.label}: ${value.format()}`, {
      tint: this.targetValueTint(),
      dismissAfterMs: TARGET_VALUE_READOUT_MS,
    });
  }

  /** The colour of the value the brush now paints, for the readout. */
  private targetValueTint(): StatusTint | undefined {
    const painting = this.getPainting();
    if (painting === undefined) return undefined;
    const { targetLayerId, activeValue } = painting.getState();
    if (BigInt(activeValue) === 0n) return "none";
    return this.host.segmentColorFor(targetLayerId, activeValue);
  }

  // -- Ctrl+Arrow parameter scheme (TM-337) ---------------------------------

  /** The active session's parameter cursor, or undefined when unavailable. */
  private getCursor(): PaintParamCursor | undefined {
    return this.host.painting?.paramCursor;
  }

  /** True while a brush/eraser/fill tool is active (the scheme's scope). */
  private isPaintToolActive(): boolean {
    return isPaintLikeToolId(this.host.activeToolId.value);
  }

  /** Surface the currently-selected parameter + its value in the center readout. */
  private showSelected(cursor: PaintParamCursor): void {
    const sel = cursor.selected();
    if (sel === undefined) return;
    // Target value, reached with Ctrl/Option+Arrows too, carries its colour.
    if (sel.id === TARGET_VALUE_PARAM_ID) {
      this.statusOverlay.show(`${sel.label}: ${sel.format()}`, {
        tint: this.targetValueTint(),
        dismissAfterMs: TARGET_VALUE_READOUT_MS,
      });
      return;
    }
    this.statusOverlay.show(`${sel.label}: ${sel.format()}`);
  }

  /**
   * Ctrl+Left / Ctrl+Right: move the selection cursor through the active panel's
   * enabled parameters. Returns whether the keypress was handled (so the caller
   * stops propagation only then, leaving the binding inert outside a paint tool).
   */
  private moveParam(dir: number): boolean {
    if (!this.isPaintToolActive()) return false;
    const cursor = this.getCursor();
    if (cursor === undefined || cursor.getDescriptors().length === 0) {
      return false;
    }
    cursor.moveSelection(dir);
    this.showSelected(cursor);
    return true;
  }

  /**
   * Ctrl+Up / Ctrl+Down: begin a hold-to-accelerate session for the selected
   * parameter. Applies one step immediately (so a tap always nudges by one),
   * then — for numeric params — an animation-frame loop integrates the
   * acceleration curve while the arrow stays held. Enum/boolean params step once
   * and do not accelerate. Auto-repeat key-downs are ignored while a session is
   * already running. Returns whether the keypress was handled.
   */
  private startParamRamp(dir: number, arrowCode: string): boolean {
    if (!this.isPaintToolActive()) return false;
    const cursor = this.getCursor();
    if (cursor === undefined || cursor.getDescriptors().length === 0) {
      return false;
    }
    // Already running (OS auto-repeat or the opposite arrow): keep the first.
    if (this.ramp !== null) return true;
    const sel = cursor.ensureSelection();
    if (sel === undefined) return false;
    sel.adjust(dir, 1);
    this.showSelected(cursor);
    const now = performance.now();
    this.ramp = {
      dir,
      arrowCode,
      startMs: now,
      lastMs: now,
      accum: 0,
      rafId: requestAnimationFrame(this.rampTick),
    };
    return true;
  }

  /** Animation-frame step of the active hold-to-accelerate session. */
  private readonly rampTick = (): void => {
    const ramp = this.ramp;
    if (ramp === null) return;
    const cursor = this.getCursor();
    const sel = cursor?.selected();
    // Stop on release of the arrow or the chord modifier, a tool switch, or a
    // vanished cursor. The modifier is Ctrl (Win/Linux) or Option (macOS), and
    // may be rebound, so accept any of Ctrl/Alt/Meta rather than a specific one.
    const modifierHeld =
      this.tracker.isHeld("controlleft") ||
      this.tracker.isHeld("controlright") ||
      this.tracker.isHeld("altleft") ||
      this.tracker.isHeld("altright") ||
      this.tracker.isHeld("metaleft") ||
      this.tracker.isHeld("metaright");
    if (
      sel === undefined ||
      !this.isPaintToolActive() ||
      !this.tracker.isHeld(ramp.arrowCode) ||
      !modifierHeld
    ) {
      this.stopRamp();
      return;
    }
    // Only numeric params accelerate; enum/boolean already stepped once.
    if (sel.kind === "number") {
      const t = performance.now();
      const dt = (t - ramp.lastMs) / 1000;
      ramp.lastMs = t;
      ramp.accum += accelStepsPerSecond(t - ramp.startMs) * dt;
      const steps = Math.floor(ramp.accum);
      if (steps >= 1) {
        ramp.accum -= steps;
        sel.adjust(ramp.dir, steps);
        this.showSelected(cursor!);
      }
    }
    ramp.rafId = requestAnimationFrame(this.rampTick);
  };

  /** Cancel the active hold-to-accelerate session, if any. */
  private stopRamp(): void {
    if (this.ramp !== null) {
      cancelAnimationFrame(this.ramp.rafId);
      this.ramp = null;
    }
  }
}

function isPaintLikeToolId(toolId: string | undefined): boolean {
  return (
    toolId === TOOL_ID_BRUSH ||
    toolId === TOOL_ID_ERASE ||
    toolId === TOOL_ID_FILL
  );
}
