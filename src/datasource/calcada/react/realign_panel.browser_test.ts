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

import type {
  RealignPanelSession,
  RealignStatus,
  RealignSummary,
} from "#src/datasource/calcada/react/realign_panel.js";
import { RealignPanel } from "#src/datasource/calcada/react/realign_panel.js";
import type { RealignCommitRow } from "#src/datasource/calcada/realign/realign_commit.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

const SIDE_PANEL_WIDTH_PX = 260;

const SUMMARY_DEFAULTS = {
  arrows: [],
  onMain: false,
  canCommit: false,
} as const;

function makeSession(
  partial: Omit<RealignSummary, keyof typeof SUMMARY_DEFAULTS> &
    Partial<RealignSummary>,
) {
  const summary: RealignSummary = { ...SUMMARY_DEFAULTS, ...partial };
  const apply = vi.fn(async () => {});
  const session: RealignPanelSession = {
    status: new WatchableValue<RealignStatus>({ kind: "idle", message: "" }),
    summary: new WatchableValue<RealignSummary>(summary),
    drawBox: vi.fn(),
    addCorrespondence: vi.fn(),
    apply,
    clearPreview: vi.fn(),
    cancel: vi.fn(),
    focusArrow: vi.fn(),
    removeAllArrows: vi.fn(),
    plannedSections: vi.fn(() => 7),
    commit: vi.fn(async () => {}),
    commits: new WatchableValue<readonly RealignCommitRow[]>([]),
    undo: vi.fn(async () => {}),
    referenceOffset: new WatchableValue(-1),
    setReferenceOffset: vi.fn(),
  };
  return { session, apply };
}

let tab: HTMLDivElement;
let disposer: Disposer;

afterEach(() => {
  invokeDisposer(disposer);
  tab.remove();
});

async function mountPanel(session: RealignPanelSession) {
  tab = document.createElement("div");
  tab.className = "calcada-realign-tab";
  tab.style.cssText = `width: ${SIDE_PANEL_WIDTH_PX}px; height: 600px;`;
  document.body.appendChild(tab);
  disposer = mountComponent(tab, RealignPanel, { session });
  await vi.waitFor(() => {
    expect(tab.querySelector(".calcada-realign-panel")).not.toBe(null);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...tab.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}

describe("RealignPanel", () => {
  it("shows why it is unavailable and keeps Apply disabled", async () => {
    const { session } = makeSession({
      hasBox: true,
      lineCount: 2,
      rejected: [],
      unavailableReason: "No GPU backend is configured for this viewer build.",
    });
    await mountPanel(session);
    expect(tab.textContent).toContain("No GPU backend is configured");
    expect(button("Apply").disabled).toBe(true);
  });

  it("counts correspondences, explains rejected lines and applies", async () => {
    const { session, apply } = makeSession({
      hasBox: true,
      boxSection: 3104,
      lineCount: 2,
      rejected: [{ id: "x", reason: "outside-box" }],
      arrows: [
        { id: "a", lengthPx: 2, sections: [3104, 3103] },
        { id: "b", lengthPx: 2, sections: [3104, 3103] },
        {
          id: "x",
          lengthPx: 2,
          sections: [3104, 3103],
          rejected: "outside-box",
        },
      ],
    });
    await mountPanel(session);
    expect(tab.textContent).toContain(
      "Box on z 3104 · 3 correspondences · 1 rejected",
    );
    expect(tab.textContent).toContain("an end is outside the box");
    const applyButton = button("Apply");
    expect(applyButton.disabled).toBe(false);
    applyButton.click();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("names the sections a cross-section arrow is on and the ones it needs", async () => {
    const { session } = makeSession({
      hasBox: true,
      boxSection: 3103,
      referenceSection: 3102,
      lineCount: 0,
      rejected: [{ id: "a", reason: "not-across-sections" }],
      arrows: [
        {
          id: "a",
          lengthPx: 21.1,
          sections: [3103, 3104],
          rejected: "not-across-sections",
        },
      ],
    });
    await mountPanel(session);
    expect(tab.textContent).toContain("on z 3103 → 3104, needs 3103 → 3102");
  });

  it("picks the reference section and names the pair", async () => {
    const { session } = makeSession({
      hasBox: true,
      boxSection: 3104,
      referenceSection: 3106,
      lineCount: 0,
      rejected: [],
    });
    await mountPanel(session);
    expect(tab.textContent).toContain("z 3104 → 3106");
    const select = tab.querySelector<HTMLSelectElement>(
      'select[aria-label="Reference section"]',
    )!;
    expect([...select.options].map((option) => option.value)).toEqual([
      "-3",
      "-2",
      "-1",
      "1",
      "2",
      "3",
    ]);
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(session.setReferenceOffset).toHaveBeenCalledWith(2);
  });

  it("disables Apply without a box", async () => {
    const { session } = makeSession({
      hasBox: false,
      lineCount: 3,
      rejected: [],
    });
    await mountPanel(session);
    expect(button("Apply").disabled).toBe(true);
  });

  it("shows the status message", async () => {
    const { session } = makeSession({
      hasBox: true,
      lineCount: 1,
      rejected: [],
    });
    await mountPanel(session);
    session.status.value = { kind: "working", message: "Computing the field…" };
    await vi.waitFor(() => {
      expect(tab.textContent).toContain("Computing the field…");
    });
    expect(button("Apply").disabled).toBe(true);
  });

  it("shows the commit progress, pieces cut included", async () => {
    const { session } = makeSession({
      hasBox: true,
      lineCount: 1,
      rejected: [],
    });
    await mountPanel(session);
    session.status.value = {
      kind: "committing",
      message: "Writing section 1 of 3 (12 pieces cut)…",
    };
    await vi.waitFor(() => {
      expect(tab.textContent).toContain(
        "Writing section 1 of 3 (12 pieces cut)…",
      );
    });
  });

  it("offers Cancel while working", async () => {
    const { session } = makeSession({
      hasBox: true,
      lineCount: 1,
      rejected: [],
    });
    await mountPanel(session);
    session.status.value = { kind: "working", message: "Computing the field…" };
    await vi.waitFor(() => {
      expect(tab.textContent).toContain("Cancel");
    });
    button("Cancel").click();
    expect(session.cancel).toHaveBeenCalledTimes(1);
  });
  it("lists arrows with length, residual and the rejection reason, and focuses one on click", async () => {
    const { session } = makeSession({
      hasBox: true,
      lineCount: 2,
      rejected: [{ id: "c", reason: "outside-box" }],
      arrows: [
        { id: "a", lengthPx: 6.2, sections: [32, 31], residualPx: 0.4 },
        { id: "c", lengthPx: 3, sections: [32, 31], rejected: "outside-box" },
      ],
      residualMeanPx: 0.4,
      onMain: false,
      canCommit: false,
    });
    await mountPanel(session);
    expect(tab.textContent).toContain("6.2 px");
    expect(tab.textContent).toContain("0.4 px");
    expect(tab.textContent).toContain("an end is outside the box");
    tab.querySelector<HTMLElement>('[data-arrow-id="a"]')!.click();
    expect(session.focusArrow).toHaveBeenCalledWith("a");
  });

  it("asks for an inline confirmation naming the section count before committing", async () => {
    const { session } = makeSession({
      hasBox: true,
      lineCount: 3,
      rejected: [],
      arrows: [],
      onMain: false,
      canCommit: true,
    });
    await mountPanel(session);
    button("Commit").click();
    await vi.waitFor(() => expect(tab.textContent).toContain("7 sections"));
    button("Confirm").click();
    expect(session.commit).toHaveBeenCalledWith(1);
  });

  it("on main shows only the way to a branch, like the Trace tab", async () => {
    const { session } = makeSession({
      hasBox: true,
      lineCount: 3,
      rejected: [],
      arrows: [],
      onMain: true,
      canCommit: true,
    });
    await mountPanel(session);
    expect(tab.textContent).toContain("Realign works on a branch only");
    expect(tab.textContent).toContain("Switch to a branch");
    expect(
      [...tab.querySelectorAll("button")].map((found) => found.textContent),
    ).toEqual([]);
  });

  it("lists commits with Undo enabled only when undoable, and names the blocker", async () => {
    const { session } = makeSession({
      hasBox: false,
      lineCount: 0,
      rejected: [],
    });
    session.commits.value = [
      {
        operationId: 12,
        box: [50, 50, 150, 150],
        z0: 12,
        sections: 4,
        status: "completed",
        undoable: true,
      },
      {
        operationId: 11,
        box: [0, 0, 100, 100],
        z0: 10,
        sections: 5,
        status: "completed",
        undoable: false,
        blockedBy: 12,
      },
    ];
    await mountPanel(session);
    const newer = tab.querySelector<HTMLElement>('[data-commit-id="12"]')!;
    const older = tab.querySelector<HTMLElement>('[data-commit-id="11"]')!;
    const undoOf = (row: HTMLElement) =>
      [...row.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Undo",
      )!;
    expect(undoOf(newer).disabled).toBe(false);
    expect(undoOf(older).disabled).toBe(true);
    expect(older.textContent).toContain("undo #12 first");
    undoOf(newer).click();
    expect(session.undo).toHaveBeenCalledWith(12);
  });

  it("says when the branch has no commits", async () => {
    const { session } = makeSession({
      hasBox: false,
      lineCount: 0,
      rejected: [],
    });
    await mountPanel(session);
    expect(tab.textContent).toContain("No commits on this branch.");
  });
});
