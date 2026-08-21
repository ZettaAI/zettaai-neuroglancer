/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The draft pattern has one hard edge: a commit must happen for input the user
 * did not type. `ParamInput` deliberately holds back commits while a field is
 * focused, which silently swallowed the native number spinner — the value moved
 * on screen but nothing downstream ever saw it. These tests pin both halves:
 * typing stays uncommitted, stepping commits at once.
 *
 * Written with `h` rather than JSX so it stays a `.spec.ts` in the node/jsdom
 * project (the workspace globs `*.spec.ts` only).
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, it, expect, vi } from "vitest";

import { ParamInput } from "#src/editing/ui/tool_settings/param_input.js";

let container: HTMLDivElement | undefined;

afterEach(() => {
  if (container !== undefined) {
    render(null, container);
    container.remove();
    container = undefined;
  }
});

/** Mount a numeric `ParamInput` and return its element plus the commit spy. */
function mountNumberField(value = 5) {
  const host = document.createElement("div");
  container = host;
  document.body.appendChild(host);
  const onCommit = vi.fn();
  // `act` flushes the mount effect, so its initial draft sync cannot land in the
  // middle of a later interaction.
  act(() =>
    render(
      h(ParamInput<number>, {
        type: "number",
        min: 1,
        step: 2,
        value,
        parse: (raw: string) => {
          const parsed = Number(raw);
          return raw.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
        },
        onCommit,
      }),
      host,
    ),
  );
  const input = host.querySelector("input");
  expect(input).not.toBeNull();
  return { input: input as HTMLInputElement, onCommit };
}

/**
 * What the browser does when the spinner buttons (or arrow keys on a number
 * field) change the value: the value steps, then `input` and `change` both fire.
 * jsdom's `stepUp` is silent, so the events are dispatched explicitly.
 */
function stepValue(input: HTMLInputElement, direction: "up" | "down") {
  if (direction === "up") input.stepUp();
  else input.stepDown();
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** What the browser does while the user types: `input` only, never `change`. */
function typeValue(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ParamInput", () => {
  it("commits immediately when the spinner steps the value", () => {
    const { input, onCommit } = mountNumberField(5);
    act(() => stepValue(input, "up"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(7); // step=2
    act(() => stepValue(input, "down"));
    expect(onCommit).toHaveBeenLastCalledWith(5);
  });

  it("does not commit while the user is typing", () => {
    const { input, onCommit } = mountNumberField(5);
    input.focus();
    act(() => typeValue(input, "1"));
    act(() => typeValue(input, "13"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits the typed value on blur", () => {
    const { input, onCommit } = mountNumberField(5);
    input.focus();
    // `act` flushes the draft re-render, which a real browser does between the
    // keystroke and the blur; without it the blur handler still closes over the
    // pre-typing draft.
    act(() => typeValue(input, "13"));
    input.blur();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(13);
  });

  it("ignores a step that leaves the field unparseable", () => {
    const { input, onCommit } = mountNumberField(5);
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
  });
});
