/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import type { ListboxOption } from "#src/widget/listbox_dropdown.js";
import { ListboxDropdown } from "#src/widget/listbox_dropdown.js";

// Long enough, and enough of them, that the panel would overflow whichever
// edge the trigger sits against if the flip/clamp logic didn't run.
const OPTIONS: ListboxOption[] = Array.from({ length: 30 }, (_, i) => ({
  key: String(i),
  label: `branch option number ${i} with a fairly long descriptive name`,
}));

let anchor: HTMLDivElement;

afterEach(() => {
  act(() => {
    render(null, anchor);
  });
  anchor.remove();
});

/**
 * Mounts a ListboxDropdown whose trigger sits pinned to one corner of the
 * real viewport, via `position: fixed` on the anchor — unlike jsdom (all-zero
 * rects, fixed 768x1024 innerHeight/innerWidth), this runs in real Chromium,
 * so `updateRect()` sees the trigger's true on-screen position and the
 * flip/clamp branches actually execute.
 */
function mountNearCorner(corner: {
  vertical: "top" | "bottom";
  horizontal: "left" | "right";
}) {
  anchor = document.createElement("div");
  anchor.style.position = "fixed";
  anchor.style.width = "160px";
  anchor.style[corner.vertical] = "8px";
  anchor.style[corner.horizontal] = "8px";
  document.body.appendChild(anchor);

  act(() => {
    render(
      h(ListboxDropdown, {
        options: OPTIONS,
        value: "0",
        onChange: () => {},
        ariaLabel: "Test",
      }),
      anchor,
    );
  });
}

function openPanel() {
  const trigger = anchor.querySelector<HTMLButtonElement>(
    ".neuroglancer-listbox-dropdown-trigger",
  )!;
  act(() => {
    trigger.click();
  });
}

/**
 * The panel only appears once the `updateRect()` effect has run and set
 * `rect` state — in a real browser (unlike jsdom under `act()`) that lands a
 * frame after the click, not synchronously, so wait for it rather than
 * reading the DOM immediately.
 */
async function panelRect(): Promise<DOMRect> {
  await expect
    .poll(() => document.querySelector(".neuroglancer-listbox-dropdown-panel"))
    .not.toBeNull();
  return document
    .querySelector(".neuroglancer-listbox-dropdown-panel")!
    .getBoundingClientRect();
}

describe("ListboxDropdown viewport safety (real browser)", () => {
  it("flips upward and stays on-screen when the trigger sits at the bottom", async () => {
    mountNearCorner({ vertical: "bottom", horizontal: "left" });
    openPanel();
    const rect = await panelRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  it("stays on-screen when the trigger sits at the top", async () => {
    mountNearCorner({ vertical: "top", horizontal: "left" });
    openPanel();
    const rect = await panelRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  it("anchors right and stays on-screen when the trigger sits at the right edge", async () => {
    mountNearCorner({ vertical: "top", horizontal: "right" });
    openPanel();
    const rect = await panelRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  });

  it("stays fully on-screen in every corner at once", async () => {
    for (const vertical of ["top", "bottom"] as const) {
      for (const horizontal of ["left", "right"] as const) {
        mountNearCorner({ vertical, horizontal });
        openPanel();
        const rect = await panelRect();
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
        expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
        act(() => {
          render(null, anchor);
        });
        anchor.remove();
      }
    }
  });
});
