/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import { CalcadaOverviewState } from "#src/datasource/calcada/candidate_overview_state.js";
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

function makeConnection(rejectedBy: string[] = []): TracePanelConnection {
  const zettaTraceState = new ZettaTraceState();
  zettaTraceState.active.value = true;
  zettaTraceState.sphereCenter.value = Float32Array.of(149532, 124617, 7226);
  zettaTraceState.rejectedBy.value = rejectedBy;
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

// Wide enough to read its "anyone" placeholder.
const REVIEWER_INPUT_MIN_WIDTH_PX = 40;

describe("CalcadaTracePanel", () => {
  it("shows the reviewer picker's placeholder when nobody is picked", async () => {
    await mountPanel(makeConnection());
    const input = tab.querySelector<HTMLInputElement>(
      ".calcada-trace-panel-reviewers input",
    )!;
    expect(input.placeholder).toBe("anyone");
    expect(input.getBoundingClientRect().width).toBeGreaterThan(
      REVIEWER_INPUT_MIN_WIDTH_PX,
    );
  });

  it("fits the side panel without scrolling sideways", async () => {
    await mountPanel(makeConnection(["a.very.long.reviewer.name@zetta.ai"]));
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
