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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";
import { TruncatedLabel } from "#src/widget/react/truncated_label.js";

// No spaces: this is the case that used to stretch the bubble into one
// unbreakable line, and it is also the text we drag-select below.
const LABEL =
  "branch_with_a_deliberately_unbroken_name_that_will_not_fit_the_panel";

// Generous on purpose: these waits end as soon as their condition holds, so
// the ceiling only has to clear the worst runner, never the common case.
const TIMEOUT = { timeout: 5000 };

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
  await labelRendered();
});

afterEach(() => {
  invokeDisposer(disposer);
  target.remove();
  window.getSelection()?.removeAllRanges();
});

function labelElement() {
  return target.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')!;
}

// createRoot().render commits asynchronously, and a loaded CI runner can take
// far longer to get there than any fixed delay allows — waiting on the label
// itself rather than on a stopwatch is what keeps this suite from flaking.
function labelRendered() {
  return vi.waitFor(() => {
    if (target.querySelector('[data-slot="tooltip-trigger"]') === null) {
      throw new Error("TruncatedLabel has not rendered yet");
    }
  }, TIMEOUT);
}

function bubble() {
  return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

async function settle(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The bubble's zoom/fade, once it has actually been put in the DOM. */
const OPEN_ANIMATION = 200;

/** The provider's hover delay (`component_mount.ts`), plus room to spare. */
const HOVER_DELAY = 500;

async function remount(text: string) {
  invokeDisposer(disposer);
  disposer = mountComponent(target, TruncatedLabel, { text });
  await labelRendered();
}

async function hoverLabel() {
  await userEvent.hover(labelElement());
  // The provider's hover delay is the other stopwatch a loaded runner
  // overruns, so wait for the bubble itself and only then let it animate in.
  await vi.waitFor(() => {
    const content = bubble();
    if (content === null || content.hasAttribute("data-closed")) {
      throw new Error("the tooltip has not opened yet");
    }
  }, TIMEOUT);
  await settle(OPEN_ANIMATION);
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

  it("says nothing about a label that fits its row", async () => {
    await remount("main");
    const label = labelElement();
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);

    await userEvent.hover(label);
    // Absence is the assertion, so this one genuinely has to sit out the
    // hover delay rather than poll for something to appear.
    await settle(HOVER_DELAY + OPEN_ANIMATION);
    expect(bubble()).toBeNull();
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

  it("disappears as soon as the pointer leaves the label", async () => {
    await hoverLabel();
    expect(bubble()).not.toBeNull();

    await userEvent.unhover(labelElement());
    // Closing starts on the way out, with no grace period for travelling
    // into a bubble that cannot be reached anyway: by now it is fading, or
    // on a slow runner already gone — what it must not still be is open.
    await settle(40);
    const leaving = bubble();
    expect(leaving === null || leaving.hasAttribute("data-closed")).toBe(true);
    // Only the fade is left after that.
    await vi.waitFor(() => {
      if (bubble() !== null) throw new Error("the tooltip is still there");
    }, TIMEOUT);
  });

  it("does not intercept the pointer", async () => {
    await hoverLabel();
    const content = bubble()!;
    expect(getComputedStyle(content).pointerEvents).toBe("none");
    const rect = content.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    expect(content.contains(hit)).toBe(false);
  });
});
