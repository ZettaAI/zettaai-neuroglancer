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
 * @file Which keydowns a `KeyboardEventBinder` is allowed to act on.
 *
 * The case that matters here is a focused `<button>`. A button edits no text,
 * so a modifier shortcut arriving while one has focus is the user driving the
 * app, not typing — and the most ordinary gesture in the editing topbar
 * (click Undo, then press the redo shortcut) lands exactly there.
 */

import { describe, expect, it } from "vitest";

import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import { KeyboardEventBinder } from "#src/util/keyboard_bindings.js";

function pressZ(
  target: EventTarget,
  from: HTMLElement,
  modifiers: { shiftKey?: boolean } = {},
): void {
  from.dispatchEvent(
    new KeyboardEvent("keydown", {
      code: "KeyZ",
      metaKey: true,
      bubbles: true,
      ...modifiers,
    }),
  );
  void target;
}

/** Fires the binder against `document` and reports the actions it dispatched. */
function actionsFiredFrom(from: HTMLElement, binding: string): string[] {
  const map = EventActionMap.fromObject({ [binding]: "my-action" });
  const binder = new KeyboardEventBinder(document, map);
  const fired: string[] = [];
  const unregister = registerActionListener(document, "my-action", () => {
    fired.push("my-action");
  });
  try {
    pressZ(document, from, { shiftKey: binding.includes("shift") });
  } finally {
    unregister();
    binder.dispose();
  }
  return fired;
}

describe("KeyboardEventBinder", () => {
  it("acts on a modifier shortcut sent from a focused button", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();

    try {
      expect(actionsFiredFrom(button, "meta+shift+keyz")).toEqual([
        "my-action",
      ]);
    } finally {
      button.remove();
    }
  });

  /**
   * Text fields keep the old behaviour: Cmd+A / Cmd+C / Cmd+Z there belong to
   * the field, and handing them to an app action would hijack editing.
   */
  it("leaves a modifier shortcut to a focused text input", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();

    try {
      expect(actionsFiredFrom(input, "meta+keyz")).toEqual([]);
    } finally {
      input.remove();
    }
  });
});
