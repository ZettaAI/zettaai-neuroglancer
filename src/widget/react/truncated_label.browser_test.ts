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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";
import { TruncatedLabel } from "#src/widget/react/truncated_label.js";

// No spaces: this is the case that used to stretch the bubble into one
// unbreakable line, and it is also the text we drag-select below.
const LABEL =
  "branch_with_a_deliberately_unbroken_name_that_will_not_fit_the_panel";

let target: HTMLDivElement;
let disposer: Disposer;

beforeEach(async () => {
  target = document.createElement("div");
  // Narrow and away from the viewport edges, so the label really is
  // ellipsized and the bubble has room on every side.
  target.style.cssText =
    "position: fixed; top: 200px; left: 200px; width: 120px; display: flex;";
  document.body.appendChild(target);
  disposer = mountComponent(target, TruncatedLabel, { text: LABEL });
  // createRoot().render commits asynchronously; nothing is in the DOM yet.
  await settle(50);
});

afterEach(() => {
  invokeDisposer(disposer);
  target.remove();
  window.getSelection()?.removeAllRanges();
});

function labelElement() {
  return target.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')!;
}

function bubble() {
  return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

async function settle(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The provider's hover delay, plus room for the open animation. */
const OPEN_WAIT = 900;

async function hoverLabel() {
  await userEvent.hover(labelElement());
  await settle(OPEN_WAIT);
}

describe("TruncatedLabel", () => {
  it("ellipsizes the label instead of wrapping it", () => {
    const label = labelElement();
    const style = getComputedStyle(label);
    expect(style.textOverflow).toBe("ellipsis");
    expect(style.whiteSpace).toBe("nowrap");
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  });

  it("reveals the full text in a tooltip on hover", async () => {
    expect(bubble()).toBeNull();
    await hoverLabel();
    expect(bubble()?.textContent).toContain(LABEL);
  });

  it("hard-wraps the unbroken name inside the bubble", async () => {
    await hoverLabel();
    const content = bubble()!;
    expect(getComputedStyle(content).overflowWrap).toBe("anywhere");
    // Wrapped rather than one long line: taller than a single row, and no
    // wider than the bubble's own max width.
    expect(content.getBoundingClientRect().height).toBeGreaterThan(24);
    expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
  });

  it("lets the pointer move into the bubble without closing it", async () => {
    await hoverLabel();
    await userEvent.hover(bubble()!);
    await settle(500);
    expect(bubble()?.textContent).toContain(LABEL);
  });

  it("allows the tooltip text to be selected with the mouse", async () => {
    await hoverLabel();
    const content = bubble()!;
    expect(getComputedStyle(content).userSelect).not.toBe("none");

    // A real triple-click, so this fails if the bubble is pointer-events:none,
    // closes on press, or is marked unselectable.
    await userEvent.tripleClick(content);
    await settle(100);

    expect(window.getSelection()?.toString()).toContain(LABEL);
  });
});
