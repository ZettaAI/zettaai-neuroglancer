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

import type {
  CalcadaBranch,
  CalcadaGraphSource,
} from "#src/datasource/calcada/frontend.js";
import { CalcadaBranchPicker } from "#src/datasource/calcada/react/branch_picker.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { SegmentationUserLayerGroupState } from "#src/layer/segmentation/index.js";
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
let disposer: Disposer;
let branchId: TrackableValue<number>;

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
  const segmentationGroupState = {
    selectedSegments: { clear: () => {} },
    visibleSegments: { clear: () => {} },
    segmentEquivalences: { clear: () => {} },
  } as unknown as SegmentationUserLayerGroupState;
  return { graph, branchId, segmentationGroupState };
}

async function settle(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The provider's hover delay, plus room for the open animation. */
const OPEN_WAIT = 900;

beforeEach(async () => {
  const { graph, segmentationGroupState, branchId: id } = makeGraph();
  branchId = id;
  target = document.createElement("div");
  // The real constraint: a side panel far narrower than these names.
  target.style.cssText =
    "position: fixed; top: 120px; left: 120px; width: 220px;";
  target.className = "neuroglancer-calcada-branch-control";
  document.body.appendChild(target);
  disposer = mountComponent(target, CalcadaBranchPicker, {
    graph,
    branchId,
    segmentationGroupState,
  });
  await settle(50);
});

afterEach(() => {
  invokeDisposer(disposer);
  target.remove();
  window.getSelection()?.removeAllRanges();
});

function dropdown() {
  return document.querySelector<HTMLElement>('[data-slot="combobox-content"]');
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
    target.querySelector<HTMLElement>('[data-slot="combobox-trigger"]')!,
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

  it("does not select the option when its tooltip is pressed", async () => {
    await openDropdown();
    const long = options().find((option) => option.textContent === LONG_NAME)!;
    await userEvent.hover(long);
    await settle(OPEN_WAIT);

    await userEvent.click(bubble()!);
    await settle(150);

    // React portals bubble through the React tree, so the bubble sits inside
    // the option as far as events are concerned. Reaching for the name must
    // not commit a branch switch or tear the list down.
    expect(dropdown()).not.toBeNull();
    expect(bubble()).not.toBeNull();
    expect(branchId.value).toBe(0);
  });
});
