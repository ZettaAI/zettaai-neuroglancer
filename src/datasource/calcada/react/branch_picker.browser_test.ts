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

import "#src/datasource/calcada/calcada.css";

import type {
  CalcadaBranch,
  CalcadaGraphSource,
} from "#src/datasource/calcada/frontend.js";
import { CalcadaBranchPicker } from "#src/datasource/calcada/react/branch_picker.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { TrackableValue, WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

// No spaces to break at, and far wider than the panel: the case that has to
// ellipsize in the row and hard-wrap in the bubble.
const LONG_NAME =
  "branch_with_a_deliberately_unbroken_name_that_will_not_fit_the_panel";

const BRANCHES: CalcadaBranch[] = [
  { id: 1, name: LONG_NAME, status: "active", parentId: 0 },
  { id: 2, name: "short", status: "active", parentId: 0 },
];

let target: HTMLDivElement;
let host: HTMLDivElement;
let branchLabel: HTMLDivElement;
let disposer: Disposer;
let branchId: TrackableValue<number>;

/**
 * The Graph tab's real row shape: the shared label/control grid, one
 * `display: contents` row inside it, and the branch control as that row's
 * control element. The branch control hands its blocks to the grid rather
 * than laying them out itself, so mounting it bare would measure a layout
 * the tab never renders.
 */
function mountBranchRow() {
  target = document.createElement("div");
  // The real constraint: a side panel far narrower than these names.
  target.style.cssText =
    "position: fixed; top: 120px; left: 120px; width: 220px;";
  const grid = document.createElement("div");
  grid.className = "neuroglancer-calcada-layer-controls";
  const row = document.createElement("div");
  row.className = "neuroglancer-layer-control-container";
  branchLabel = document.createElement("div");
  branchLabel.className = "neuroglancer-layer-control-label-container";
  branchLabel.textContent = "Branch";
  host = document.createElement("div");
  host.className = "neuroglancer-calcada-branch-control";
  row.appendChild(branchLabel);
  row.appendChild(host);
  grid.appendChild(row);
  target.appendChild(grid);
  document.body.appendChild(target);
}

function makeGraph() {
  const branchId = new TrackableValue<number>(0, (x) => x);
  const branches = new WatchableValue<CalcadaBranch[]>([...BRANCHES]);
  const graph = {
    branches,
    branchId,
    triggerBranchRefresh: () => {},
    info: {
      app: {
        segmentationUrl: "middleauth+https://graph.example.com/segmentation",
        table: "tbl",
      },
    },
  } as unknown as CalcadaGraphSource;
  return { graph, branchId };
}

async function settle(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The provider's hover delay, plus room for the open animation. */
const OPEN_WAIT = 900;

beforeEach(async () => {
  const { graph, branchId: id } = makeGraph();
  branchId = id;
  mountBranchRow();
  disposer = mountComponent(host, CalcadaBranchPicker, {
    graph,
    branchId,
  });
  await pickerRendered();
});

afterEach(() => {
  invokeDisposer(disposer);
  target.remove();
  window.getSelection()?.removeAllRanges();
});

// createRoot().render commits asynchronously, and a loaded CI runner can take
// far longer to get there than any fixed delay allows — waiting on the trigger
// itself rather than on a stopwatch is what keeps this suite from flaking.
function pickerRendered() {
  return vi.waitFor(() => {
    if (host.querySelector('[data-slot="combobox-trigger"]') === null) {
      throw new Error("CalcadaBranchPicker has not rendered yet");
    }
  });
}

function options() {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
  ];
}

function bubble() {
  return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

async function openDropdown() {
  await userEvent.click(
    host.querySelector<HTMLElement>('[data-slot="combobox-trigger"]')!,
  );
  await settle(150);
}

describe("CalcadaBranchPicker in a narrow panel", () => {
  it("keeps each option on one ellipsized line", async () => {
    await openDropdown();
    const labels = options().map(
      (option) =>
        option.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')!,
    );
    expect(labels.length).toBeGreaterThan(1);
    for (const label of labels) {
      expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
    }
    const long = labels.find((label) => label.textContent === LONG_NAME)!;
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
  });

  it("shows the full option name in a tooltip on hover", async () => {
    await openDropdown();
    const long = options().find((option) => option.textContent === LONG_NAME)!;
    await userEvent.hover(long);
    await settle(OPEN_WAIT);
    expect(bubble()?.textContent).toContain(LONG_NAME);
  });

  it('stacks the new-branch name input under its "from" picker', async () => {
    await userEvent.click(
      host.querySelector<HTMLElement>(".neuroglancer-calcada-branch-new")!,
    );
    const form = host.querySelector<HTMLElement>(
      ".neuroglancer-calcada-branch-create-form",
    )!;
    await vi.waitFor(() => {
      if (form.style.display === "none") {
        throw new Error("the new-branch form has not opened yet");
      }
    });
    const parent = form
      .querySelector<HTMLElement>(".neuroglancer-calcada-branch-select")!
      .getBoundingClientRect();
    const name = form
      .querySelector<HTMLInputElement>('input[name="branch_name"]')!
      .getBoundingClientRect();
    expect(name.top).toBeGreaterThanOrEqual(parent.bottom);
  });

  it("keeps the option's tooltip out of the pointer's way", async () => {
    await openDropdown();
    const long = options().find((option) => option.textContent === LONG_NAME)!;
    await userEvent.hover(long);
    await settle(OPEN_WAIT);

    const content = bubble()!;
    expect(getComputedStyle(content).pointerEvents).toBe("none");
    // The bubble overlaps neighbouring rows, so if it swallowed the pointer
    // it would block the very options it is describing.
    const rect = content.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    expect(content.contains(hit)).toBe(false);
    expect(branchId.value).toBe(0);
  });
});

describe("Graph tab branch row layout", () => {
  function picker() {
    return host.querySelector<HTMLElement>('[data-slot="combobox-trigger"]')!;
  }

  function block(selector: string) {
    return host.querySelector<HTMLElement>(selector)!;
  }

  it("centres the Branch label on its picker, not on the whole block", () => {
    const label = branchLabel.getBoundingClientRect();
    const trigger = picker().getBoundingClientRect();
    const group = block(
      ".neuroglancer-calcada-branch-new-group",
    ).getBoundingClientRect();
    const labelMiddle = label.top + label.height / 2;

    // A couple of pixels of slack, not none: the label's box is a line box,
    // so its height — and with it where rounding lands — moves with whatever
    // font the platform resolves. The regression this guards against is off
    // by far more than that.
    const pickerMiddle = trigger.top + trigger.height / 2;
    expect(Math.abs(labelMiddle - pickerMiddle)).toBeLessThan(2);

    // The other half of the claim, and the one with real room in it: centred
    // on the whole branch block (picker plus the new-branch section under it)
    // would drop the label most of a row below the picker it names.
    const blockMiddle = (trigger.top + group.bottom) / 2;
    expect(Math.abs(labelMiddle - blockMiddle)).toBeGreaterThan(8);
  });

  it("uses one spacing step for every gap in the row", () => {
    const grid = target.querySelector<HTMLElement>(
      ".neuroglancer-calcada-layer-controls",
    )!;
    const gridStyle = getComputedStyle(grid);
    const gaps = [gridStyle.rowGap, gridStyle.columnGap];
    for (const selector of [
      ".neuroglancer-calcada-branch-new-group",
      ".neuroglancer-calcada-branch-actions",
      ".neuroglancer-calcada-branch-create-form",
    ]) {
      const style = getComputedStyle(block(selector));
      gaps.push(style.rowGap, style.columnGap);
    }
    expect(new Set(gaps).size).toBe(1);
  });

  it("divides the new-branch block from the picker by more than that step", () => {
    const trigger = picker().getBoundingClientRect();
    const group = block(".neuroglancer-calcada-branch-new-group");
    const step = Number.parseFloat(
      getComputedStyle(block(".neuroglancer-calcada-branch-actions")).rowGap,
    );
    expect(group.getBoundingClientRect().top - trigger.bottom).toBeGreaterThan(
      step,
    );
  });

  async function showDiffLink() {
    branchId.value = 1;
    return vi.waitFor(() => {
      const element = host.querySelector<HTMLElement>(".calcada-open-diff");
      if (element === null) throw new Error("the diff link has not rendered");
      return element;
    });
  }

  it('puts "Open diff" at the right end of the New branch row', async () => {
    // Both buttons together need more than the 220px panel the rest of this
    // suite pins; a panel dragged wide enough for them is where sharing a row
    // is the question at all.
    target.style.width = "340px";
    const diff = await showDiffLink();
    const diffRect = diff.getBoundingClientRect();
    const newRect = block(
      ".neuroglancer-calcada-branch-new",
    ).getBoundingClientRect();
    expect(diffRect.top).toBeCloseTo(newRect.top, 0);
    expect(diffRect.left).toBeGreaterThan(newRect.right);
    const actions = block(
      ".neuroglancer-calcada-branch-actions",
    ).getBoundingClientRect();
    expect(actions.right - diffRect.right).toBeLessThan(1);
  });

  it('keeps "Open diff" right-aligned once the panel is too narrow to share', async () => {
    const diff = await showDiffLink();
    const diffRect = diff.getBoundingClientRect();
    const newRect = block(
      ".neuroglancer-calcada-branch-new",
    ).getBoundingClientRect();
    expect(diffRect.top).toBeGreaterThanOrEqual(newRect.bottom);
    const actions = block(
      ".neuroglancer-calcada-branch-actions",
    ).getBoundingClientRect();
    expect(actions.right - diffRect.right).toBeLessThan(1);
  });
});
