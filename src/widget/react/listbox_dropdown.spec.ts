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

import type { ListboxOption } from "#src/widget/react/listbox_dropdown.js";
import { ListboxDropdown } from "#src/widget/react/listbox_dropdown.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: ListboxOption[] = [
  { key: "a", label: "alpha" },
  { key: "b", label: "beta", disabled: true },
  { key: "c", label: "gamma" },
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

function mount(props: Partial<Parameters<typeof ListboxDropdown>[0]> = {}) {
  const onChange = vi.fn();
  act(() => {
    root.render(
      createElement(ListboxDropdown, {
        options: OPTIONS,
        value: "a",
        onChange,
        ...props,
      }),
    );
  });
  return onChange;
}

function openPanel() {
  const trigger = container.querySelector<HTMLButtonElement>(
    ".neuroglancer-listbox-dropdown-trigger",
  )!;
  act(() => {
    trigger.click();
  });
}

function panel(): HTMLElement {
  return document.querySelector<HTMLElement>(
    ".neuroglancer-listbox-dropdown-panel",
  )!;
}

function optionElements(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      ".neuroglancer-listbox-dropdown-option",
    ),
  ];
}

function optionLabels(): string[] {
  return optionElements().map((el) => el.textContent ?? "");
}

function pressKey(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

// React installs a value tracker on controlled inputs and drops "input" events
// whose value it already knows about, so a plain `input.value = x` assignment
// never reaches onChange. Write through the prototype setter the tracker wraps.
const nativeInputValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

function typeQuery(input: HTMLInputElement, value: string) {
  act(() => {
    nativeInputValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ListboxDropdown disabled options", () => {
  it("marks the option disabled and refuses to commit it", () => {
    const onChange = mount();
    openPanel();
    const [, betaOption] = optionElements();
    expect(betaOption.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      betaOption.click();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
  });

  it("skips disabled options when the arrow keys move the cursor", () => {
    const onChange = mount();
    openPanel();
    pressKey(panel(), "ArrowDown");
    pressKey(panel(), "Enter");
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("lands End on the last selectable option", () => {
    const onChange = mount({
      options: [...OPTIONS, { key: "d", label: "delta", disabled: true }],
    });
    openPanel();
    pressKey(panel(), "End");
    pressKey(panel(), "Enter");
    expect(onChange).toHaveBeenCalledWith("c");
  });
});

describe("ListboxDropdown filtering", () => {
  it("renders no search box unless filterable", () => {
    mount();
    openPanel();
    expect(
      document.querySelector(".neuroglancer-listbox-dropdown-search"),
    ).toBeNull();
  });

  it("narrows the options to case-insensitive substring matches", () => {
    mount({ filterable: true });
    openPanel();
    const search = document.querySelector<HTMLInputElement>(
      ".neuroglancer-listbox-dropdown-search",
    )!;
    expect(optionLabels()).toEqual(["alpha", "beta", "gamma"]);
    typeQuery(search, "MM");
    expect(optionLabels()).toEqual(["gamma"]);
  });

  it("commits the filtered cursor from the search box", () => {
    const onChange = mount({ filterable: true });
    openPanel();
    const search = document.querySelector<HTMLInputElement>(
      ".neuroglancer-listbox-dropdown-search",
    )!;
    typeQuery(search, "a");
    pressKey(search, "ArrowDown");
    pressKey(search, "Enter");
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("focuses the search box rather than an option when opening", () => {
    mount({ filterable: true });
    openPanel();
    expect(document.activeElement).toBe(
      document.querySelector(".neuroglancer-listbox-dropdown-search"),
    );
  });
});

function mockTriggerRect(rect: { left: number; width: number; top: number }) {
  const domRect = {
    left: rect.left,
    right: rect.left + rect.width,
    width: rect.width,
    top: rect.top,
    bottom: rect.top + 24,
    height: 24,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect;
  return vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(domRect);
}

describe("ListboxDropdown panel geometry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("anchors left and caps width to the space rightward of the trigger", () => {
    mount();
    mockTriggerRect({ left: 10, width: 200, top: 100 });
    openPanel();
    const { style } = panel();
    expect(style.left).toBe("10px");
    expect(style.right).toBe("");
    expect(style.maxWidth).toBe("480px");
  });

  it("anchors right and caps width when the trigger sits near the right viewport edge", () => {
    mount();
    const left = window.innerWidth - 220;
    mockTriggerRect({ left, width: 200, top: 100 });
    openPanel();
    const { style } = panel();
    expect(style.left).toBe("");
    expect(style.right).toBe("20px");
    expect(style.maxWidth).toBe("480px");
    expect(style.minWidth).toBe("200px");
  });

  it("caps width to the viewport space when it is under the preferred width", () => {
    mount();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(400);
    mockTriggerRect({ left: 10, width: 200, top: 100 });
    openPanel();
    // 400 viewport - 10 left - 8 margin.
    expect(panel().style.maxWidth).toBe("382px");
  });
});

describe("ListboxDropdown onOpen", () => {
  it("fires only on the closed-to-open transition", () => {
    const onOpen = vi.fn();
    mount({ onOpen });
    openPanel();
    expect(onOpen).toHaveBeenCalledTimes(1);
    openPanel();
    expect(onOpen).toHaveBeenCalledTimes(1);
    openPanel();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
