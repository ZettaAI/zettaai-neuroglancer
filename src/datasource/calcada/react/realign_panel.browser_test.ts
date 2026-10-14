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
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

const SIDE_PANEL_WIDTH_PX = 260;

function makeSession(summary: RealignSummary) {
  const apply = vi.fn(async () => {});
  const session: RealignPanelSession = {
    status: new WatchableValue<RealignStatus>({ kind: "idle", message: "" }),
    summary: new WatchableValue<RealignSummary>(summary),
    drawBox: vi.fn(),
    addCorrespondence: vi.fn(),
    apply,
    clearPreview: vi.fn(),
    cancel: vi.fn(),
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
      lineCount: 3,
      rejected: [{ id: "x", reason: "outside-box" }],
    });
    await mountPanel(session);
    expect(tab.textContent).toContain("3 correspondences");
    expect(tab.textContent).toContain("an end is outside the box");
    const applyButton = button("Apply");
    expect(applyButton.disabled).toBe(false);
    applyButton.click();
    expect(apply).toHaveBeenCalledTimes(1);
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
});
