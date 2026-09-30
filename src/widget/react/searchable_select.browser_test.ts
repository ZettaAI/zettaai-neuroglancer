/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";
import type { ListboxOption } from "#src/widget/listbox_dropdown.js";
import { SearchableSelect } from "#src/widget/react/searchable_select.js";

const OPTIONS: ListboxOption[] = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Bravo" },
  { key: "c", label: "Charlie", disabled: true },
];

let target: HTMLDivElement;
let disposer: Disposer;

function mount(props: Partial<Parameters<typeof SearchableSelect>[0]> = {}) {
  target = document.createElement("div");
  document.body.appendChild(target);
  const onChange = vi.fn();
  disposer = mountComponent(target, SearchableSelect, {
    options: OPTIONS,
    value: "a",
    onChange,
    ariaLabel: "Test",
    ...props,
  });
  return { onChange };
}

afterEach(() => {
  invokeDisposer(disposer);
  target.remove();
});

function selectTrigger() {
  return target.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
}

function comboboxTrigger() {
  return target.querySelector<HTMLElement>('[data-slot="combobox-trigger"]')!;
}

function selectItems() {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
  ];
}

// createRoot().render commits asynchronously, and a loaded CI runner can take
// far longer to get there than any fixed delay allows — waiting on the
// trigger itself rather than on a stopwatch is what keeps this suite from
// flaking (mirrors branch_picker.browser_test.ts's pickerRendered()).
function rendered(find: () => HTMLElement | null) {
  return vi.waitFor(() => {
    if (find() === null) {
      throw new Error("SearchableSelect has not rendered yet");
    }
  });
}

describe("SearchableSelect (non-searchable, Select-backed) in a real browser", () => {
  it("picks an option on click", async () => {
    const { onChange } = mount();
    await rendered(selectTrigger);
    await userEvent.click(selectTrigger());
    const bravo = selectItems().find((item) => item.textContent === "Bravo")!;
    await userEvent.click(bravo);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("does not select a disabled option", async () => {
    const { onChange } = mount();
    await rendered(selectTrigger);
    await userEvent.click(selectTrigger());
    const charlie = selectItems().find(
      (item) => item.textContent === "Charlie",
    )!;
    // A real user-event click waits for the target to become "actionable",
    // which a `pointer-events: none` disabled item never does — dispatch the
    // click directly instead of waiting on that check to time out.
    charlie.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SearchableSelect trigger box parity", () => {
  it("renders the same height, border, and font size searchable or not", async () => {
    mount({ searchable: false });
    await rendered(selectTrigger);
    const plain = getComputedStyle(selectTrigger());
    const plainBox = {
      height: plain.height,
      border: plain.borderColor,
      font: plain.fontSize,
    };
    invokeDisposer(disposer);
    target.remove();

    mount({ searchable: true });
    await rendered(comboboxTrigger);
    const searchable = getComputedStyle(comboboxTrigger());
    expect({
      height: searchable.height,
      border: searchable.borderColor,
      font: searchable.fontSize,
    }).toEqual(plainBox);
  });
});
