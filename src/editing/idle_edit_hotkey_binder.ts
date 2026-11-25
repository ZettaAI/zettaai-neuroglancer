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
 * @file Idle (no-session) keyboard shortcut layer (TM-290, TM-344).
 *
 * Installs two idle edit-session chords for the whole viewer lifetime:
 *
 *   - `Ctrl+E` / `Cmd+E` → open the Enter-Edit-Session modal directly, without
 *     drawing a region (dispatches `requestSessionEntry` with no bbox).
 *   - `Ctrl+Shift+E` / `Cmd+Shift+E` → "quick edit-region capture": draw a
 *     2-corner box, then open the modal pre-selected on that box.
 *
 * Unlike `EditSessionHotkeyBinder` (which is session-scoped), this binder is
 * always installed but only acts when NO session is active:
 *
 *   - During a session, `EditSessionHotkeyBinder` installs `control+keye →
 *     erase` at a higher priority (`SESSION_HOTKEY_PRIORITY = 100`), so these
 *     lower-priority bindings are shadowed.
 *   - The handlers additionally guard on `host.activeSession`, no-op'ing while
 *     a session is active.
 *
 * Uses the same `addParent(map, priority)` idiom as the session binder rather
 * than touching the shared `default_input_event_bindings.ts`, keeping all
 * edit hotkeys isolated in the editing domain.
 */

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

// Lower than `SESSION_HOTKEY_PRIORITY` (100) so an active session's bindings
// win, but > 0 so it overrides any direct global binding on the same chord.
const IDLE_HOTKEY_PRIORITY = 50;

export const ACTION_OPEN_ENTRY = "edit-session-open-entry";
export const ACTION_QUICK_REGION = "edit-session-quick-region";

/** Keys that open the entry modal while no session is active. */
export const OPEN_ENTRY_KEYS: readonly string[] = ["control+keye", "meta+keye"];
/** Keys that start the quick edit-region capture while no session is active. */
export const QUICK_REGION_KEYS: readonly string[] = [
  "control+shift+keye",
  "meta+shift+keye",
];

/**
 * The keys hints name: Ctrl even on a Mac. Cmd+E is often taken before the page
 * sees it (the Claude app and browser extensions claim it), so the hint points
 * at the chord that reliably arrives; Cmd+E still works where it is free.
 */
export const OPEN_ENTRY_SHOWN_KEYS: readonly string[] = ["control+keye"];
export const QUICK_REGION_SHOWN_KEYS: readonly string[] = [
  "control+shift+keye",
];

export class IdleEditHotkeyBinder extends RefCounted {
  constructor(host: EditSessionHost, viewer: Viewer) {
    super();

    const actionMap = EventActionMap.fromObject({
      ...Object.fromEntries(
        OPEN_ENTRY_KEYS.map((key) => [key, ACTION_OPEN_ENTRY]),
      ),
      ...Object.fromEntries(
        QUICK_REGION_KEYS.map((key) => [key, ACTION_QUICK_REGION]),
      ),
    });
    actionMap.label = "Edit (idle)";

    this.registerDisposer(
      viewer.inputEventMap.addParent(actionMap, IDLE_HOTKEY_PRIORITY),
    );

    this.registerDisposer(
      registerActionListener(viewer.element, ACTION_OPEN_ENTRY, (event) => {
        // No-op while a session is active; otherwise open the entry modal
        // directly, with no pre-selected region.
        if (host.activeSession.value !== undefined) return;
        event.stopPropagation();
        host.requestSessionEntry.dispatch(undefined);
      }),
    );

    this.registerDisposer(
      registerActionListener(viewer.element, ACTION_QUICK_REGION, (event) => {
        // No-op while a session is active; otherwise begins capture.
        if (host.activeSession.value !== undefined) return;
        event.stopPropagation();
        host.beginQuickRegionCapture();
      }),
    );
  }
}
