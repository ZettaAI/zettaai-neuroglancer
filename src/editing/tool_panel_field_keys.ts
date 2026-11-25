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
 * Session keys while a tool panel field has focus. Neuroglancer gives a focused
 * field every key without Ctrl, Cmd or Alt, which is right for typing but left
 * `{`, Ctrl+B and the rest dead after a click on Size or Target value. A number
 * field or a list cannot take those characters anyway, so they go to their
 * action; what the field can type (digits, `-`, `.`, `e`) stays with it.
 */

/**
 * Ctrl / Cmd letters a field keeps: select all, copy, paste, cut, undo, redo.
 * Any other Ctrl letter (the tools: Ctrl+B, Ctrl+E, Ctrl+G) goes to its action.
 */
const FIELD_EDITING_LETTER = /^[acvxyz]$/i;
const LETTER = /^[a-z]$/i;

/** Characters a number field accepts, besides editing and arrow keys. */
const NUMBER_FIELD_CHARACTER = /^[0-9eE+\-.,]$/;

const FIELD_SELECTOR = 'input[type="number"], select';
const TOOL_PANEL_SELECTOR = ".neuroglancer-edit-session-tool-panel";

/**
 * Whether a keydown in a tool panel field should run a session action instead.
 * Pure apart from reading the target's place in the document, for tests.
 */
export function isFieldKeyForSession(
  target: EventTarget | null,
  key: string,
  modifiers: { ctrlKey: boolean; metaKey: boolean; altKey: boolean },
): boolean {
  if (!(target instanceof Element)) return false;
  if (!target.matches(FIELD_SELECTOR)) return false;
  if (target.closest(TOOL_PANEL_SELECTOR) === null) return false;
  if (key.length !== 1) return false;
  if (modifiers.altKey) return false;
  if (modifiers.ctrlKey || modifiers.metaKey) {
    return LETTER.test(key) && !FIELD_EDITING_LETTER.test(key);
  }
  return !(
    target instanceof HTMLInputElement && NUMBER_FIELD_CHARACTER.test(key)
  );
}
