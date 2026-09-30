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

import type { ListboxOption } from "#src/widget/listbox_dropdown.js";
import { SearchableSelect } from "#src/widget/react/searchable_select.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: ListboxOption[] = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Bravo" },
  { key: "c", label: "Charlie", disabled: true },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mount(props: Partial<Parameters<typeof SearchableSelect>[0]> = {}) {
  const onChange = vi.fn();
  const onOpen = vi.fn();
  act(() => {
    root.render(
      createElement(SearchableSelect, {
        options: OPTIONS,
        value: "a",
        onChange,
        onOpen,
        ariaLabel: "Test",
        ...props,
      }),
    );
  });
  return { onChange, onOpen };
}

// React's value tracker swallows plain `input.value = x`; use the prototype setter.
const nativeInputValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

describe("SearchableSelect (non-searchable, Select-backed)", () => {
  function trigger() {
    return container.querySelector<HTMLButtonElement>(
      '[data-slot="select-trigger"]',
    )!;
  }

  function items() {
    return [
      ...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
    ];
  }

  // Base UI's Select commits a pointer selection through a real PointerEvent,
  // which jsdom in this project does not implement at all (`PointerEvent is
  // not defined`) — so click-to-select is covered in
  // `searchable_select.browser_test.ts` (real Chromium) instead of here.

  function triggerLabel() {
    return trigger().querySelector('[data-slot="tooltip-trigger"]');
  }

  it("shows the selected option's label on the trigger", () => {
    mount();
    expect(triggerLabel()?.textContent).toBe("Alpha");
  });

  it("fires onOpen when the popup opens", () => {
    const { onOpen } = mount();
    act(() => {
      trigger().click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders a disabled option with the disabled state", () => {
    mount();
    act(() => {
      trigger().click();
    });
    const charlie = items().find((item) => item.textContent === "Charlie")!;
    expect(charlie.getAttribute("data-disabled")).not.toBeNull();
  });
});

describe("SearchableSelect (searchable, Combobox-backed)", () => {
  function trigger() {
    return container.querySelector<HTMLButtonElement>(
      '[data-slot="combobox-trigger"]',
    )!;
  }

  function items() {
    return [
      ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
    ];
  }

  function typeQuery(value: string) {
    const input = document.querySelector<HTMLInputElement>(
      '[data-slot="combobox-content"] input',
    )!;
    act(() => {
      nativeInputValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("shows the selected option's label on the trigger", () => {
    mount({ searchable: true });
    expect(trigger().textContent).toBe("Alpha");
  });

  it("fires onOpen when the popup opens", () => {
    const { onOpen } = mount({ searchable: true });
    act(() => {
      trigger().click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("calls onChange with the picked option's key", () => {
    const { onChange } = mount({ searchable: true });
    act(() => {
      trigger().click();
    });
    const bravo = items().find((item) => item.textContent === "Bravo")!;
    act(() => {
      bravo.click();
    });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("filters options by substring", () => {
    mount({ searchable: true });
    act(() => {
      trigger().click();
    });
    typeQuery("bra");
    expect(items().map((item) => item.textContent)).toEqual(["Bravo"]);
  });

  it("shows the empty-state text when nothing matches", () => {
    mount({ searchable: true, emptyText: "Nothing here." });
    act(() => {
      trigger().click();
    });
    typeQuery("zzz");
    expect(
      document.querySelector('[data-slot="combobox-empty"]')?.textContent,
    ).toBe("Nothing here.");
  });
});
