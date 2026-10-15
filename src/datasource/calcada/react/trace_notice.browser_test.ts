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
});
