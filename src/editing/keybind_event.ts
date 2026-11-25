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
 * Helpers for the runtime edit-hotkey rebind UI (TM-315): convert a captured
 * `KeyboardEvent` into a neuroglancer `EventActionMap` key identifier (e.g.
 * `"control+keyb"`), and format an identifier for display (e.g. `"Ctrl+B"`).
 *
 * Kept dependency-free + pure so the round-trip is unit-testable without the
 * viewer. The identifier grammar mirrors what `mergeEditKeybinds` emits and
 * what neuroglancer's `parseEventIdentifier` consumes: lowercased
 * `event.code`, modifier prefixes (`control`/`meta`/`shift`/`alt`) joined with
 * `+`, modifiers ordered control→meta→shift→alt.
 */

import { formatChord } from "#src/ui/key_chord_format.js";

const MODIFIER_CODE = /^(?:Control|Shift|Alt|Meta|OS)(?:Left|Right)?$/;

/**
 * Build the NG event identifier for a captured keydown, or `undefined` when the
 * event is a lone modifier press (so the caller keeps listening for the real
 * key). Modifiers are emitted in NG's canonical order.
 */
export function keyboardEventToIdentifier(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
): string | undefined {
  const { code } = event;
  if (code === "" || MODIFIER_CODE.test(code)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("control");
  if (event.metaKey) parts.push("meta");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");
  parts.push(code.toLowerCase());
  return parts.join("+");
}

/** Format an NG event identifier for a message, e.g. `"control+keyb"` → `"Ctrl+B"`. */
export function formatKeyIdentifier(identifier: string): string {
  return formatChord(identifier, /*mac=*/ false).replaceAll("−", "-");
}
