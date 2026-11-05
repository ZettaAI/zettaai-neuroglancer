/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RowPayloadEditing } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { RowPayloadEditor } from "#src/datasource/calcada/annotation_tables/row_payload_editor.js";
import { Signal } from "#src/util/signal.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SAVED = { size: 3, kind: "spine", note: "outside the schema" };
const REFUSAL = "Could not save the annotation: payload does not match";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function editing(overrides: Partial<RowPayloadEditing> = {}) {
  return {
    properties: { size: "number", kind: "string" },
    requiredProperties: ["size"],
    readonly: false,
    readonlyChanged: new Signal<() => void>(),
    read: vi.fn(async () => ({ ...SAVED })),
    save: vi.fn(async () => {}),
    ...overrides,
  } satisfies RowPayloadEditing;
}

async function mount(rowEditing: RowPayloadEditing) {
  await act(async () => {
    root.render(createElement(RowPayloadEditor, { editing: rowEditing }));
  });
}

const field = (name: string) =>
  container.querySelector<HTMLInputElement>(`[aria-label^="${name}"]`)!;

const saveButton = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  );

async function type(name: string, text: string) {
  const input = field(name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

async function clickSave() {
  await act(async () => {
    saveButton()!.click();
  });
}

describe("RowPayloadEditor", () => {
  it("shows each schema field with the row's saved value", async () => {
    await mount(editing());
    expect(field("size").value).toBe("3");
    expect(field("kind").value).toBe("spine");
  });

  it("does not save an edited field when it is left", async () => {
    const rowEditing = editing();
    await mount(rowEditing);
    await type("size", "7");
    expect(rowEditing.save).not.toHaveBeenCalled();
  });

  it("saves the whole payload with the edited field on Save", async () => {
    const rowEditing = editing();
    await mount(rowEditing);
    await type("size", "7");
    await clickSave();
    expect(rowEditing.save).toHaveBeenCalledWith({ ...SAVED, size: 7 });
  });

  it("saves on Enter in a field", async () => {
    const rowEditing = editing();
    await mount(rowEditing);
    await type("size", "7");
    await act(async () => {
      field("size").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(rowEditing.save).toHaveBeenCalledWith({ ...SAVED, size: 7 });
  });

  it("offers Save only while the payload differs from the saved one", async () => {
    await mount(editing());
    expect(saveButton()!.disabled).toBe(true);
    await type("size", "7");
    expect(saveButton()!.disabled).toBe(false);
    await type("size", "3");
    expect(saveButton()!.disabled).toBe(true);
  });

  it("offers no Save again once the edit is saved", async () => {
    await mount(editing());
    await type("size", "7");
    await clickSave();
    expect(saveButton()!.disabled).toBe(true);
  });

  it("names a refusal and returns the field to its saved value", async () => {
    const rowEditing = editing({
      save: vi.fn(() => Promise.reject(new Error(REFUSAL))),
    });
    await mount(rowEditing);
    await type("kind", "shaft");
    await clickSave();
    expect(container.textContent).toContain(REFUSAL);
    expect(field("kind").value).toBe("spine");
  });

  it("only shows the fields of a row it cannot write", async () => {
    await mount(editing({ readonly: true }));
    expect(field("size").disabled).toBe(true);
    expect(field("kind").disabled).toBe(true);
    expect(saveButton()).toBeUndefined();
  });

  it("unlocks and locks the fields as the row's writability changes", async () => {
    const readonlyChanged = new Signal<() => void>();
    const live = editing({ readonly: true, readonlyChanged });
    await mount(live);
    expect(field("size").disabled).toBe(true);
    await act(async () => {
      live.readonly = false;
      readonlyChanged.dispatch();
    });
    expect(field("size").disabled).toBe(false);
    await act(async () => {
      live.readonly = true;
      readonlyChanged.dispatch();
    });
    expect(field("size").disabled).toBe(true);
  });

  it("names why the row could not be read", async () => {
    await mount(
      editing({
        read: () => Promise.reject(new Error("gone")),
      }),
    );
    expect(container.textContent).toContain("gone");
  });
});
