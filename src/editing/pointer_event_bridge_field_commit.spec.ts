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
 * A value typed into a tool-panel field must reach the tool when the user then
 * presses on a viewer panel (TM-519). The panel's `mousedown` bindings call
 * `preventDefault`, which keeps the field focused, so `ParamInput` never saw the
 * blur it commits on: "Binary closing: 4" stayed on screen and strokes kept
 * using 0. The bridge now blurs the field on `pointerdown`.
 *
 * Written with `h` rather than JSX so it stays a `.spec.ts` in the jsdom project.
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, it, expect, vi } from "vitest";

import {
  PointerEventBridge,
  commitFieldBeingEdited,
} from "#src/editing/pointer_event_bridge.js";
import { ParamInput } from "#src/editing/ui/tool_settings/param_input.js";

vi.hoisted(() => {
  (globalThis as any).WebGL2RenderingContext ??= {};
});

let mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted) {
    render(null, element);
    element.remove();
  }
  mounted = [];
});

function attach<T extends HTMLElement>(element: T): T {
  mounted.push(element);
  document.body.appendChild(element);
  return element;
}

/** A tool-panel number field the user has typed `typed` into, still focused. */
function fieldBeingEdited(typed: string) {
  const host = attach(document.createElement("div"));
  const onCommit = vi.fn();
  act(() =>
    render(
      h(ParamInput<number>, {
        type: "number",
        value: 0,
        parse: (raw: string) => {
          const parsed = Number(raw);
          return raw.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
        },
        onCommit,
      }),
      host,
    ),
  );
  const input = host.querySelector("input") as HTMLInputElement;
  input.focus();
  act(() => {
    input.value = typed;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { input, onCommit };
}

describe("commitFieldBeingEdited", () => {
  it("commits a typed tool-panel value before the panel press reaches the tool", () => {
    const { input, onCommit } = fieldBeingEdited("4");
    const panel = attach(document.createElement("div"));
    expect(onCommit).not.toHaveBeenCalled();

    act(() => commitFieldBeingEdited(panel));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(4);
    expect(document.activeElement).not.toBe(input);
  });

  it("leaves focus alone when the focused field is inside the panel", () => {
    const panel = attach(document.createElement("div"));
    const inner = document.createElement("input");
    panel.appendChild(inner);
    inner.focus();

    commitFieldBeingEdited(panel);

    expect(document.activeElement).toBe(inner);
  });

  it("a press on a panel commits the field before the event reaches the tool", () => {
    const { onCommit } = fieldBeingEdited("4");
    const panelElement = attach(document.createElement("div"));
    // The bridge's panel listeners over a fake `this`, as in
    // `pointer_event_bridge.spec.ts`. The camera is unlocked so the press is
    // dispatched without starting a stroke.
    const commitsSeenByTool: number[] = [];
    const bridge = {
      isCameraLockedForEvent: () => false,
      strokeToChainBehind: () => undefined,
      dispatch: vi.fn(() => {
        commitsSeenByTool.push(onCommit.mock.calls.length);
      }),
    };
    const detach = (PointerEventBridge.prototype as any).attachPanel.call(
      bridge,
      { element: panelElement },
    );

    act(() => {
      panelElement.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
    detach();

    expect(commitsSeenByTool).toEqual([1]);
    expect(onCommit).toHaveBeenCalledWith(4);
  });

  it("leaves a focused non-field element alone", () => {
    const button = attach(document.createElement("button"));
    const panel = attach(document.createElement("div"));
    button.focus();

    commitFieldBeingEdited(panel);

    expect(document.activeElement).toBe(button);
  });
});
