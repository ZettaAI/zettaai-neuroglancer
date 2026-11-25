/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { isFieldKeyForSession } from "#src/editing/tool_panel_field_keys.js";

const NO_MODIFIERS = { ctrlKey: false, metaKey: false, altKey: false };

function fieldInToolPanel(html: string): Element {
  const panel = document.createElement("div");
  panel.className = "neuroglancer-edit-session-tool-panel";
  panel.innerHTML = html;
  document.body.appendChild(panel);
  return panel.firstElementChild!;
}

describe("isFieldKeyForSession", () => {
  const numberField = fieldInToolPanel('<input type="number">');

  it("hands a number field's impossible characters to the session", () => {
    expect(isFieldKeyForSession(numberField, "}", NO_MODIFIERS)).toBe(true);
    expect(isFieldKeyForSession(numberField, "b", NO_MODIFIERS)).toBe(true);
  });

  it("leaves what a number field can type with the field", () => {
    for (const key of ["7", "-", ".", "e", "+"]) {
      expect(isFieldKeyForSession(numberField, key, NO_MODIFIERS)).toBe(false);
    }
    expect(isFieldKeyForSession(numberField, "Backspace", NO_MODIFIERS)).toBe(
      false,
    );
  });

  it("hands every printable key on a list to the session", () => {
    const list = fieldInToolPanel("<select><option>a</option></select>");
    expect(isFieldKeyForSession(list, "e", NO_MODIFIERS)).toBe(true);
  });

  it("hands a Ctrl or Cmd letter to the session, but keeps the editing ones", () => {
    const ctrl = { ...NO_MODIFIERS, ctrlKey: true };
    const cmd = { ...NO_MODIFIERS, metaKey: true };
    for (const key of ["b", "e", "g"]) {
      expect(isFieldKeyForSession(numberField, key, ctrl)).toBe(true);
      expect(isFieldKeyForSession(numberField, key, cmd)).toBe(true);
    }
    for (const key of ["a", "c", "v", "x", "y", "z"]) {
      expect(isFieldKeyForSession(numberField, key, ctrl)).toBe(false);
      expect(isFieldKeyForSession(numberField, key, cmd)).toBe(false);
    }
    expect(
      isFieldKeyForSession(numberField, "b", { ...NO_MODIFIERS, altKey: true }),
    ).toBe(false);
  });

  it("never takes a text field, a modified key, or a field elsewhere", () => {
    const textField = fieldInToolPanel('<input type="text">');
    expect(isFieldKeyForSession(textField, "}", NO_MODIFIERS)).toBe(false);
    expect(
      isFieldKeyForSession(numberField, "}", {
        ...NO_MODIFIERS,
        ctrlKey: true,
      }),
    ).toBe(false);
    const outside = document.createElement("input");
    outside.type = "number";
    document.body.appendChild(outside);
    expect(isFieldKeyForSession(outside, "}", NO_MODIFIERS)).toBe(false);
  });
});
