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

import type { TraceNotice } from "#src/datasource/calcada/react/trace_notice.js";
import { CalcadaTraceNotice } from "#src/datasource/calcada/react/trace_notice.js";
import {
  END_SPHERE_RGB,
  sphereCssColor,
} from "#src/datasource/calcada/trace_cursor/trace_sphere_appearance.js";
import type { TraceEndPromptView } from "#src/datasource/calcada/trace_end_controller.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

const BOLD_WEIGHT = "700";

let host: HTMLDivElement;
let disposer: Disposer | undefined;

afterEach(() => {
  if (disposer !== undefined) invokeDisposer(disposer);
  disposer = undefined;
  host?.remove();
});

function endActions() {
  return {
    certain: vi.fn(),
    uncertain: vi.fn(),
    deeper: vi.fn(),
    back: vi.fn(),
    shrink: vi.fn(),
    grow: vi.fn(),
  };
}

const openPrompt: TraceEndPromptView = {
  phase: "open",
  radiusNm: 1234.6,
  threshold: 0.3,
  canGoDeeper: true,
  canGoBack: true,
  canShrink: true,
  canGrow: false,
  endPoint: new Float32Array(3),
  endPointKnown: true,
};

async function mountPrompt(
  endPrompt: TraceEndPromptView,
  actions = endActions(),
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  disposer = mountComponent(host, CalcadaTraceNotice, {
    source: {
      active: new WatchableValue(true),
      seedRoot: new WatchableValue<bigint | undefined>(1n),
      session: {
        changed: new NullarySignal(),
        notice: undefined,
        endPrompt,
        endActions: actions,
      },
    },
  });
  await vi.waitFor(() => {
    expect(host.querySelector(".calcada-trace-notice")).not.toBe(null);
  });
  return actions;
}

function button(label: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith(label),
  );
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

async function mountNotice(notice: TraceNotice) {
  host = document.createElement("div");
  document.body.appendChild(host);
  disposer = mountComponent(host, CalcadaTraceNotice, {
    source: {
      active: new WatchableValue(true),
      seedRoot: new WatchableValue<bigint | undefined>(1n),
      session: { changed: new NullarySignal(), notice },
    },
  });
  await vi.waitFor(() => {
    expect(host.querySelector(".calcada-trace-notice")).not.toBe(null);
  });
}

function lines() {
  return [
    ...host.querySelectorAll<HTMLElement>(".calcada-trace-notice-detail"),
  ];
}

const sides = ["Seed: 10 vx", "Candidate: 20 vx"];

describe("CalcadaTraceNotice", () => {
  it("puts the candidate's choice right under the title, in bold when the seed wins", async () => {
    await mountNotice({
      kind: "candidate",
      title: "score 0.62 · 3 left",
      headline: { text: "Seed is the candidate's best match", bold: true },
      details: sides,
    });
    const [first, ...rest] = lines();
    expect(first.textContent).toBe("Seed is the candidate's best match");
    expect(getComputedStyle(first).fontWeight).toBe(BOLD_WEIGHT);
    expect(rest.map((line) => line.textContent)).toEqual(sides);
  });

  it("keeps an alternative in the same place, not in bold", async () => {
    await mountNotice({
      kind: "candidate",
      title: "score 0.32 · 2 left",
      headline: {
        text: "Candidate has an alternative: score 0.37",
        bold: false,
      },
      details: sides,
    });
    const [first] = lines();
    expect(first.textContent).toBe("Candidate has an alternative: score 0.37");
    expect(getComputedStyle(first).fontWeight).not.toBe(BOLD_WEIGHT);
  });

  it("shows Checking… while the end check runs", async () => {
    await mountPrompt({ ...openPrompt, phase: "checking" });
    expect(host.textContent).toContain("Checking…");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("open shows the radius, the threshold to two digits and four buttons with their key chips", async () => {
    await mountPrompt(openPrompt);
    expect(host.textContent).toContain(
      "No candidate passes the filters within 1235 nm",
    );
    expect(host.textContent).toContain("Score ≥ 0.30");
    expect(
      [...host.querySelectorAll(".calcada-trace-notice-buttons button")].map(
        (b) => b.textContent,
      ),
    ).toEqual(
      ["Certain end→", "Uncertain end←", "Look deeper↓", "Back↑"].map((text) =>
        expect.stringContaining(text.slice(0, -1)),
      ),
    );
    for (const label of [
      "Certain end",
      "Uncertain end",
      "Look deeper",
      "Back",
    ]) {
      expect(button(label).querySelector(".neuroglancer-key-chip")).not.toBe(
        null,
      );
    }
  });

  it("says what the end sphere is, in the end sphere's colour", async () => {
    await mountPrompt(openPrompt);
    const legend = host.querySelector<HTMLElement>(
      ".calcada-trace-notice-legend",
    );
    expect(legend?.textContent).toContain("Orange sphere");
    const swatch = legend?.querySelector<HTMLElement>(
      ".calcada-trace-notice-swatch",
    );
    expect(swatch?.style.backgroundColor).toBe(sphereCssColor(END_SPHERE_RGB));
  });

  it("makes the sphere smaller or larger as far as each may go", async () => {
    const actions = await mountPrompt(openPrompt);
    expect(button("Smaller").disabled).toBe(false);
    expect(button("Larger").disabled).toBe(true);
    button("Smaller").click();
    expect(actions.shrink).toHaveBeenCalledOnce();
  });

  it("disables Look deeper at 0 and Back at the start", async () => {
    await mountPrompt({ ...openPrompt, canGoDeeper: false, canGoBack: false });
    expect(button("Look deeper").disabled).toBe(true);
    expect(button("Back").disabled).toBe(true);
    expect(button("Certain end").disabled).toBe(false);
  });

  it("each button calls its action", async () => {
    const actions = await mountPrompt(openPrompt);
    button("Certain end").click();
    button("Uncertain end").click();
    button("Look deeper").click();
    button("Back").click();
    expect(actions.certain).toHaveBeenCalledOnce();
    expect(actions.uncertain).toHaveBeenCalledOnce();
    expect(actions.deeper).toHaveBeenCalledOnce();
    expect(actions.back).toHaveBeenCalledOnce();
  });

  it("keeps the prompt clickable on top of the viewer", async () => {
    await mountPrompt(openPrompt);
    expect(getComputedStyle(button("Certain end")).pointerEvents).not.toBe(
      "none",
    );
  });
});
