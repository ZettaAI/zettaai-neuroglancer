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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CalcadaBranch,
  CalcadaGraphSource,
} from "#src/datasource/calcada/frontend.js";
import {
  branchOptions,
  CalcadaBranchPicker,
} from "#src/datasource/calcada/react/branch_picker.js";
import type { SegmentationUserLayerGroupState } from "#src/layer/segmentation/index.js";
import { TrackableValue, WatchableValue } from "#src/trackable_value.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BRANCHES: CalcadaBranch[] = [
  { id: 1, name: "feature", status: "active", parentId: 0 },
  { id: 2, name: "child", status: "active", parentId: 1 },
  { id: 3, name: "copying", status: "creating", parentId: 0 },
  { id: 4, name: "landed", status: "merged", parentId: 0 },
];

interface Harness {
  graph: CalcadaGraphSource;
  branchId: TrackableValue<number>;
  branches: WatchableValue<CalcadaBranch[]>;
  segmentationGroupState: SegmentationUserLayerGroupState;
  /** Every state mutation the picker performs, in the order it performed it. */
  mutations: string[];
  refreshCount: () => number;
}

function makeHarness(initialBranchId = 0): Harness {
  const mutations: string[] = [];
  const branchId = new TrackableValue<number>(initialBranchId, (x) => x);
  branchId.changed.add(() => mutations.push(`branchId=${branchId.value}`));
  const branches = new WatchableValue<CalcadaBranch[]>([...BRANCHES]);
  let refreshes = 0;
  const graph = {
    branches,
    branchId,
    triggerBranchRefresh: () => {
      refreshes += 1;
    },
    info: {
      app: {
        segmentationUrl: "middleauth+https://graph.example.com/segmentation",
        table: "tbl",
      },
    },
  } as unknown as CalcadaGraphSource;
  const segmentationGroupState = {
    selectedSegments: { clear: () => mutations.push("selectedSegments") },
    visibleSegments: { clear: () => mutations.push("visibleSegments") },
    segmentEquivalences: {
      clear: () => mutations.push("segmentEquivalences"),
    },
  } as unknown as SegmentationUserLayerGroupState;
  return {
    graph,
    branchId,
    branches,
    segmentationGroupState,
    mutations,
    refreshCount: () => refreshes,
  };
}

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

function mount(harness: Harness) {
  act(() => {
    root.render(
      createElement(CalcadaBranchPicker, {
        graph: harness.graph,
        branchId: harness.branchId,
        segmentationGroupState: harness.segmentationGroupState,
      }),
    );
  });
}

function openPanel(scope: HTMLElement = container) {
  const trigger = scope.querySelector<HTMLButtonElement>(
    '[data-slot="combobox-trigger"]',
  )!;
  act(() => {
    trigger.click();
  });
}

function optionElements(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
  ];
}

function optionLabels(): string[] {
  return optionElements().map((el) => el.textContent ?? "");
}

// React's value tracker swallows plain `input.value = x`; use the prototype setter.
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

describe("branchOptions", () => {
  it("always offers main, even with no branches", () => {
    expect(branchOptions([], 0)).toEqual([{ key: "0", label: "main" }]);
  });

  it("shows active and creating branches and hides other statuses", () => {
    expect(branchOptions(BRANCHES, 0).map((option) => option.label)).toEqual([
      "main",
      "feature",
      "child ← feature",
      "copying (creating…)",
    ]);
  });

  it("marks creating branches disabled and the rest selectable", () => {
    const disabled = branchOptions(BRANCHES, 0).map(
      (option) => option.disabled === true,
    );
    expect(disabled).toEqual([false, false, false, true]);
  });

  it("keeps a non-active branch visible while it is the selected one", () => {
    expect(branchOptions(BRANCHES, 4).map((option) => option.label)).toEqual([
      "main",
      "feature",
      "child ← feature",
      "copying (creating…)",
      "landed (merged)",
    ]);
  });

  it("falls back to the parent id when the parent branch is unknown", () => {
    const orphan: CalcadaBranch[] = [
      { id: 9, name: "orphan", status: "active", parentId: 42 },
    ];
    expect(branchOptions(orphan, 0)[1].label).toBe("orphan ← #42");
  });
});

describe("CalcadaBranchPicker", () => {
  it("summarizes the current branch on the trigger", () => {
    const harness = makeHarness(2);
    mount(harness);
    expect(
      container.querySelector('[data-slot="combobox-trigger"]')?.textContent,
    ).toBe("child ← feature");
  });

  it("refreshes the branch list when the panel opens", () => {
    const harness = makeHarness();
    mount(harness);
    expect(harness.refreshCount()).toBe(0);
    openPanel();
    expect(harness.refreshCount()).toBe(1);
  });

  it("clears segment state before updating branchId", () => {
    const harness = makeHarness();
    mount(harness);
    openPanel();
    act(() => {
      optionElements()[1].click();
    });
    expect(harness.mutations).toEqual([
      "selectedSegments",
      "visibleSegments",
      "segmentEquivalences",
      "branchId=1",
    ]);
  });

  it("refuses to switch to a creating branch", () => {
    const harness = makeHarness();
    mount(harness);
    openPanel();
    act(() => {
      optionElements()[3].click();
    });
    expect(harness.mutations).toEqual([]);
    expect(harness.branchId.value).toBe(0);
  });

  it("re-derives the options when the branch list changes", () => {
    const harness = makeHarness();
    mount(harness);
    openPanel();
    expect(optionLabels()).toHaveLength(4);
    act(() => {
      harness.branches.value = [
        ...BRANCHES,
        { id: 5, name: "fresh", status: "active", parentId: 0 },
      ];
    });
    expect(optionLabels()).toContain("fresh");
  });

  it("gives every option a single-line label that carries its full text", () => {
    const harness = makeHarness();
    mount(harness);
    openPanel();
    const labels = optionElements().map((option) =>
      option.querySelector('[data-slot="tooltip-trigger"]'),
    );
    expect(labels.every((label) => label !== null)).toBe(true);
    expect(labels.map((label) => label!.textContent)).toEqual(optionLabels());
  });

  it("filters the options by substring", () => {
    const harness = makeHarness();
    mount(harness);
    openPanel();
    const search = document.querySelector<HTMLInputElement>(
      '[data-slot="combobox-content"] input',
    )!;
    typeQuery(search, "CHI");
    expect(optionLabels()).toEqual(["child ← feature"]);
  });

  it("hides the diff link on main and points it at the branch otherwise", () => {
    const harness = makeHarness();
    mount(harness);
    expect(container.querySelector(".calcada-open-diff")).toBeNull();
    act(() => {
      harness.branchId.value = 2;
    });
    expect(
      container.querySelector<HTMLAnchorElement>(".calcada-open-diff")?.href,
    ).toBe("https://graph.example.com/admin/graphs/tbl/branches/2/diff");
  });

  it("toggles the new-branch form and defaults its parent to the current branch", () => {
    const harness = makeHarness(1);
    mount(harness);
    const form = container.querySelector<HTMLElement>(
      ".neuroglancer-calcada-branch-create-form",
    )!;
    expect(form.style.display).toBe("none");
    act(() => {
      container
        .querySelector<HTMLButtonElement>(".neuroglancer-calcada-branch-new")!
        .click();
    });
    expect(form.style.display).toBe("");
    expect(
      form.querySelector('[data-slot="combobox-trigger"]')?.textContent,
    ).toBe("from: feature");
  });

  it("lets the user override the new-branch parent via its dropdown", () => {
    const harness = makeHarness(1);
    mount(harness);
    act(() => {
      container
        .querySelector<HTMLButtonElement>(".neuroglancer-calcada-branch-new")!
        .click();
    });
    const form = container.querySelector<HTMLElement>(
      ".neuroglancer-calcada-branch-create-form",
    )!;
    openPanel(form);
    const childOption = optionElements().find(
      (el) => el.textContent === "from: child",
    )!;
    act(() => {
      childOption.click();
    });
    expect(
      form.querySelector('[data-slot="combobox-trigger"]')?.textContent,
    ).toBe("from: child");
  });
});
