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
import { FilterEditor } from "#src/datasource/calcada/react/filter_editor.js";
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

interface PanelSetup {
  rejectedBy?: string[];
  /** Tracing, with detection on and a piece in focus; idle otherwise. */
  busy?: boolean;
  hasSegment?: boolean;
  picking?: boolean;
}

let calls: string[] = [];

async function makeConnection({
  rejectedBy = [],
  busy = true,
  hasSegment = true,
  picking = false,
}: PanelSetup = {}): Promise<TracePanelConnection> {
  const { library } = await libraryWith({
    axons: "both axon >= 30%",
    dendrites: "both dendrite > 80%",
  });
  const zettaTraceState = new ZettaTraceState();
  zettaTraceState.active.value = busy;
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
  overviewState.active.value = busy;
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    graph: { branchId: new WatchableValue(1) },
    state: { zettaTraceState, overviewState },
    segmentSession: {
      changed: new NullarySignal(),
      piece: hasSegment ? 72057594037927937n : undefined,
      picking,
      pick: record("pick"),
      goTo: record("goTo"),
      clear: record("clear"),
    },
    overviewSession: {
      changed: new NullarySignal(),
      status: busy
        ? "12 of 1,234 pieces flagged · 800 candidates with semantics"
        : "",
      focus: busy
        ? {
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
          }
        : undefined,
      previousPiece: () => {},
      nextPiece: () => {},
      showFocus: () => {},
    },
    traceSession: {
      changed: new NullarySignal(),
      status: busy ? "score 0.93 · 1 interface(s) · depth 0 · 7 left" : "",
      current: undefined,
      isBusy: false,
      reject: () => {},
      canUndo: () => false,
      skip: () => {},
      start: record("start"),
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

async function button(label: string, within = ".calcada-trace-panel") {
  return vi.waitFor(() => {
    const found = [
      ...tab.querySelectorAll<HTMLButtonElement>(`${within} button`),
    ].find((candidate) => candidate.textContent?.trim() === label);
    expect(found).toBeDefined();
    return found!;
  });
}

function layout() {
  const panel = tab.querySelector<HTMLElement>(".calcada-trace-panel")!;
  return {
    height: panel.getBoundingClientRect().height,
    // The navigator's position is a count, and counts change.
    buttons: [
      ...panel.querySelectorAll(
        "button:not(.calcada-trace-panel-navigator-position)",
      ),
    ].map((found) => found.textContent?.trim()),
  };
}

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

  it("shows the filter chosen for Trace in the open editor", async () => {
    const connection = await makeConnection();
    const { filterLibrary: library } = connection;
    const { zettaTraceState } = connection.state;
    library.select("dendrites");
    const editor = document.createElement("div");
    document.body.appendChild(editor);
    const unmountEditor = mountComponent(editor, FilterEditor, {
      library,
      state: zettaTraceState,
    });
    try {
      await mountPanel(connection);
      for (const [name, text] of [
        ["axons", "axon >= 30%"],
        ["dendrites", "dendrite > 80%"],
      ]) {
        tab.querySelector<HTMLElement>(".calcada-trace-filter-select")!.click();
        const option = await vi.waitFor(() => {
          const found = [
            ...document.querySelectorAll<HTMLElement>('[role="option"]'),
          ].find((item) => item.textContent?.trim() === name);
          expect(found).toBeDefined();
          return found!;
        });
        option.click();
        await vi.waitFor(() => {
          expect(
            editor.querySelector(".calcada-filter-library-select")?.textContent,
          ).toContain(name);
          expect(
            editor.querySelector<HTMLTextAreaElement>(
              ".calcada-filter-code textarea",
            )?.value,
          ).toContain(text);
        });
      }
    } finally {
      invokeDisposer(unmountEditor);
      editor.remove();
    }
  });

  it("selects, goes to and clears the segment being proofread", async () => {
    await mountPanel(await makeConnection());
    calls = [];
    const segment = ".calcada-trace-panel-segment";
    (await button("Select", segment)).click();
    (await button("Go to", segment)).click();
    (await button("Clear", segment)).click();
    expect(calls).toEqual(["pick", "goTo", "clear"]);
  });

  it("says no segment is selected, and offers nothing to go to or clear", async () => {
    await mountPanel(await makeConnection({ busy: false, hasSegment: false }));
    const segment = ".calcada-trace-panel-segment";
    expect(tab.querySelector(segment)?.textContent).toContain("None");
    expect((await button("Go to", segment)).disabled).toBe(true);
    expect((await button("Clear", segment)).disabled).toBe(true);
    // Both still start: each asks for the segment first.
    expect((await button("Start")).disabled).toBe(false);
    expect((await button("Detect split errors")).disabled).toBe(false);
  });

  it("says to Ctrl+click while the segment is being selected", async () => {
    await mountPanel(await makeConnection({ picking: true }));
    expect(
      tab.querySelector(".calcada-trace-panel-segment")?.textContent,
    ).toContain("Ctrl+click it in a 2D view");
  });

  it("detects split errors with a button and clears them with another", async () => {
    const connection = await makeConnection({ busy: false });
    await mountPanel(connection);
    const { active } = connection.state.overviewState;
    (await button("Detect split errors")).click();
    await vi.waitFor(() => expect(active.value).toBe(true));
    (await button("Clear", ".calcada-trace-panel-detection")).click();
    await vi.waitFor(() => expect(active.value).toBe(false));
  });

  it("offers no split detection while a trace is running or aiming", async () => {
    const connection = await makeConnection({ busy: false });
    await mountPanel(connection);
    const detection = ".calcada-trace-panel-detection";
    expect((await button("Detect split errors", detection)).disabled).toBe(
      false,
    );
    connection.state.zettaTraceState.aiming.value = true;
    await vi.waitFor(async () => {
      expect((await button("Detect split errors", detection)).disabled).toBe(
        true,
      );
    });
    connection.state.zettaTraceState.aiming.value = false;
    connection.state.zettaTraceState.active.value = true;
    connection.state.overviewState.active.value = true;
    await vi.waitFor(async () => {
      expect((await button("Detect split errors", detection)).disabled).toBe(
        true,
      );
      expect((await button("Clear", detection)).disabled).toBe(true);
    });
  });

  it("shows the green-to-red scale the points are coloured with", async () => {
    await mountPanel(await makeConnection());
    expect(tab.querySelector(".calcada-trace-panel-legend")).not.toBe(null);
  });

  it("offers no choice of how flagged pieces are shown", async () => {
    await mountPanel(await makeConnection());
    expect(tab.querySelector(".calcada-trace-panel-split-display")).toBe(null);
    expect(tab.textContent).not.toContain("Show flagged pieces as");
  });

  it("leaves describing the candidate to the banner over the views", async () => {
    await mountPanel(await makeConnection());
    expect(tab.textContent).not.toContain("Seed piece:");
    expect(tab.textContent).not.toContain("Candidate:");
  });

  it("keeps the parts of a split visible when the box is ticked", async () => {
    const connection = await makeConnection();
    await mountPanel(connection);
    const box = await vi.waitFor(() => {
      const found = [
        ...tab.querySelectorAll<HTMLLabelElement>(".calcada-trace-panel-check"),
      ].find((label) => label.textContent?.includes("parts of a split"));
      expect(found).toBeDefined();
      return found!.querySelector<HTMLInputElement>("input")!;
    });
    expect(box.checked).toBe(false);
    box.click();
    await vi.waitFor(() =>
      expect(connection.state.zettaTraceState.keepSplitParts.value).toBe(true),
    );
  });

  it("starts a trace from the tab", async () => {
    await mountPanel(await makeConnection({ busy: false }));
    calls = [];
    (await button("Start")).click();
    expect(calls).toEqual(["start"]);
  });

  it("keeps the same layout whether idle or busy", async () => {
    await mountPanel(await makeConnection({ busy: false }));
    const idle = layout();
    invokeDisposer(disposer);
    tab.remove();
    await mountPanel(await makeConnection());
    const busy = layout();
    expect(busy.buttons).toEqual(idle.buttons);
    expect(busy.height).toBe(idle.height);
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
      await makeConnection({
        rejectedBy: ["a.very.long.reviewer.name@zetta.ai"],
      }),
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
