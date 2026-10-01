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

import "#src/datasource/calcada/calcada.css";

import { printFilter } from "#src/datasource/calcada/candidate_filter_text.js";
import { CalcadaOverviewState } from "#src/datasource/calcada/candidate_overview_state.js";
import { libraryWith } from "#src/datasource/calcada/filter_library_fixture.js";
import type { TracePanelConnection } from "#src/datasource/calcada/react/trace_panel.js";
import { CalcadaTracePanel } from "#src/datasource/calcada/react/trace_panel.js";
import { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

// The layer side panel at its narrowest usable width.
const SIDE_PANEL_WIDTH_PX = 260;

const noClasses = {
  perikaryon: 0,
  dendrite: 0,
  axon: 0,
  glia: 0,
  vasculature: 0,
  nucleus: 0,
  ecs: 0,
  other: 0,
};

async function makeConnection(
  rejectedBy: string[] = [],
): Promise<TracePanelConnection> {
  const { library } = await libraryWith({
    axons: "both axon >= 30%",
    dendrites: "both dendrite > 80%",
  });
  const zettaTraceState = new ZettaTraceState();
  zettaTraceState.active.value = true;
  zettaTraceState.sphereCenter.value = Float32Array.of(149532, 124617, 7226);
  zettaTraceState.rejectedBy.value = rejectedBy;
  // The longest field label there is, which must shorten rather than widen
  // the filter section.
  zettaTraceState.filter.value = {
    kind: "group",
    op: "all",
    children: [
      {
        kind: "cond",
        field: "vasculature",
        op: ">=",
        value: 80,
        target: "candidate",
      },
    ],
  };
  const overviewState = new CalcadaOverviewState();
  overviewState.active.value = true;
  return {
    graph: { branchId: new WatchableValue(1) },
    state: { zettaTraceState, overviewState },
    overviewSession: {
      changed: new NullarySignal(),
      status: "12 of 1,234 pieces flagged · 800 candidates with semantics",
      focus: {
        index: 2,
        total: 12,
        piece: {
          pieceId: 1n,
          bestScore: 0.87,
          bestPartnerPiece: 2n,
          bestPartnerRoot: 3n,
          bestPartnerVoxels: 2125,
          partnerClasses: noClasses,
          partnerHasInfo: false,
          candidateCount: 3,
          voxelCount: 227946,
          classes: { ...noClasses, dendrite: 96, axon: 2, glia: 1 },
          hasInfo: true,
        },
      },
      hasSeed: true,
      previousPiece: () => {},
      nextPiece: () => {},
      showFocus: () => {},
      clearSeed: () => {},
      picking: false,
      pickSegment: () => {
        picks++;
      },
    },
    traceSession: {
      changed: new NullarySignal(),
      status: "score 0.93 · 1 interface(s) · depth 0 · 7 left",
      current: undefined,
      isBusy: false,
      reject: () => {},
      canUndo: () => false,
      skip: () => {},
      goToSeed: () => {},
      clearSeed: () => {},
      accept: async () => {},
      undoLast: async () => {},
    },
    listCandidateReviewers: async () => [],
    filterLibrary: library,
  };
}

let tab: HTMLDivElement;
let disposer: Disposer;

afterEach(() => {
  invokeDisposer(disposer);
  tab.remove();
});

async function mountPanel(connection: TracePanelConnection) {
  tab = document.createElement("div");
  tab.className = "calcada-trace-tab";
  tab.style.cssText = `width: ${SIDE_PANEL_WIDTH_PX}px; height: 600px;`;
  document.body.appendChild(tab);
  disposer = mountComponent(tab, CalcadaTracePanel, { connection });
  await vi.waitFor(() => {
    expect(tab.querySelector(".calcada-trace-panel-navigator")).not.toBe(null);
  });
}

async function button(label: string) {
  return vi.waitFor(() => {
    const found = [...tab.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(found).toBeDefined();
    return found!;
  });
}

let picks = 0;

// Wide enough to read its "anyone" placeholder.
const REVIEWER_INPUT_MIN_WIDTH_PX = 40;

describe("CalcadaTracePanel", () => {
  it("picks a saved filter for Trace from the dropdown", async () => {
    const connection = await makeConnection();
    await mountPanel(connection);
    const trigger = await vi.waitFor(() => {
      const found = tab.querySelector<HTMLElement>(
        ".calcada-trace-filter-select",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    trigger.click();
    const labels = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('[role="option"]')].map(
        (item) => item.textContent?.trim(),
      );
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // "(from link)" names the current filter; it is not a choice.
    expect(labels).toEqual(["— none —", "axons", "dendrites"]);
    const { zettaTraceState } = connection.state;
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent?.trim() === "dendrites")!
      .click();
    await vi.waitFor(() =>
      expect(zettaTraceState.filterPresetId.value).toBe(
        connection.filterLibrary.presetId("dendrites"),
      ),
    );
    expect(printFilter(zettaTraceState.filter.value)).toBe(
      "both dendrite > 80%",
    );
    // As in the prototype, the editor follows the Trace choice.
    expect(connection.filterLibrary.current).toBe("dendrites");
  });

  it("offers to pick the segment again", async () => {
    await mountPanel(await makeConnection());
    picks = 0;
    (await button("Pick segment")).click();
    expect(picks).toBe(1);
  });

  it("switches between coloured pieces and red points", async () => {
    const connection = await makeConnection();
    await mountPanel(connection);
    const select = await vi.waitFor(() => {
      const found = tab.querySelector<HTMLElement>(
        ".calcada-trace-panel-split-display",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    select.click();
    const option = await vi.waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((item) => item.textContent?.trim() === "Red points");
      expect(found).toBeDefined();
      return found!;
    });
    option.click();
    await vi.waitFor(() =>
      expect(connection.state.overviewState.display.value).toBe("points"),
    );
  });

  it("narrows the score range from a slider beside the filter", async () => {
    const connection = await makeConnection();
    await mountPanel(connection);
    const range = await vi.waitFor(() => {
      const found = tab.querySelector<HTMLElement>(
        ".calcada-trace-score-range",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    expect(range.textContent).toContain("0.00 – 1.00");
    const thumbs = range.querySelectorAll<HTMLInputElement>(
      'input[type="range"]',
    );
    expect(thumbs).toHaveLength(2);
    thumbs[1].focus();
    await userEvent.keyboard("{ArrowLeft}");
    await vi.waitFor(() =>
      expect(connection.state.zettaTraceState.scoreRange.value[1]).toBeCloseTo(
        0.99,
      ),
    );
    thumbs[0].focus();
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() =>
      expect(connection.state.zettaTraceState.scoreRange.value[0]).toBeCloseTo(
        0.01,
      ),
    );
    await vi.waitFor(() => expect(range.textContent).toContain("0.01 – 0.99"));
  });

  it("opens and closes the filter editor", async () => {
    const connection = await makeConnection();
    await mountPanel(connection);
    const edit = await button("Edit ▸");
    edit.click();
    await vi.waitFor(() =>
      expect(connection.state.zettaTraceState.filterEditor.visible).toBe(true),
    );
    (await button("Close editor")).click();
    await vi.waitFor(() =>
      expect(connection.state.zettaTraceState.filterEditor.visible).toBe(false),
    );
  });

  it("says Trace uses the saved version while the filter has edits", async () => {
    const connection = await makeConnection();
    const { filterLibrary: library } = connection;
    connection.state.zettaTraceState.filterPresetId.value =
      library.presetId("axons");
    library.select("axons");
    library.edit((root) => ({ ...root, children: [] }), "removing a row");
    await mountPanel(connection);
    await vi.waitFor(() =>
      expect(tab.textContent).toContain("using the saved version"),
    );
  });

  it("shows a filter with no preset behind it as from the link", async () => {
    const connection = await makeConnection();
    await mountPanel(connection);
    await vi.waitFor(() =>
      expect(
        tab.querySelector(".calcada-trace-filter-select")?.textContent,
      ).toContain("(from link)"),
    );
  });

  it("shows a linked filter it does not have as from the link", async () => {
    const connection = await makeConnection();
    connection.state.zettaTraceState.filterPresetId.value = "someone-elses";
    await mountPanel(connection);
    await vi.waitFor(() =>
      expect(
        tab.querySelector(".calcada-trace-filter-select")?.textContent,
      ).toContain("(from link)"),
    );
  });

  it("shows the reviewer picker's placeholder when nobody is picked", async () => {
    await mountPanel(await makeConnection());
    const input = tab.querySelector<HTMLInputElement>(
      ".calcada-trace-panel-reviewers input",
    )!;
    expect(input.placeholder).toBe("anyone");
    expect(input.getBoundingClientRect().width).toBeGreaterThan(
      REVIEWER_INPUT_MIN_WIDTH_PX,
    );
  });

  it("fits the side panel without scrolling sideways", async () => {
    await mountPanel(
      await makeConnection(["a.very.long.reviewer.name@zetta.ai"]),
    );
    const tabRight = tab.getBoundingClientRect().right;
    const overflowing = [...tab.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.getBoundingClientRect().right > tabRight + 1)
      .map(
        (element) =>
          `${element.tagName}.${element.className} ${Math.round(element.getBoundingClientRect().right - tabRight)}px`,
      );
    expect(overflowing).toEqual([]);
    expect(tab.scrollWidth).toBeLessThanOrEqual(tab.clientWidth);
  });
});
