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
  CalcadaGraphSource,
  CalcadaLabeledTimestamp,
} from "#src/datasource/calcada/frontend.js";
import { CalcadaLabeledTimestampPicker } from "#src/datasource/calcada/react/labeled_timestamp_picker.js";
import { TrackableValue, WatchableValue } from "#src/trackable_value.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: CalcadaLabeledTimestamp[] = [
  { id: "1", label: "Before merge", timestampMs: 1000, visibility: "public" },
  { id: "2", label: "After review", timestampMs: 2000, visibility: "admin" },
];

interface Harness {
  graph: CalcadaGraphSource;
  intermediateTimestamp: TrackableValue<number | undefined>;
  labeledTimestamps: WatchableValue<CalcadaLabeledTimestamp[]>;
  refreshCount: () => number;
}

function makeHarness(): Harness {
  const labeledTimestamps = new WatchableValue<CalcadaLabeledTimestamp[]>([
    ...LABELS,
  ]);
  let refreshes = 0;
  const graph = {
    labeledTimestamps,
    triggerLabeledTimestampRefresh: () => {
      refreshes += 1;
    },
  } as unknown as CalcadaGraphSource;
  return {
    graph,
    intermediateTimestamp: new TrackableValue<number | undefined>(
      undefined,
      (x) => x,
    ),
    labeledTimestamps,
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
      createElement(CalcadaLabeledTimestampPicker, {
        graph: harness.graph,
        intermediateTimestamp: harness.intermediateTimestamp,
      }),
    );
  });
}

function trigger() {
  return container.querySelector<HTMLButtonElement>(
    '[data-slot="select-trigger"]',
  )!;
}

function triggerLabel() {
  return trigger().querySelector('[data-slot="tooltip-trigger"]');
}

function openPanel() {
  act(() => {
    trigger().click();
  });
}

function optionElements() {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
  ];
}

// Selecting an option is covered in `labeled_timestamp_picker.browser_test.ts`
// (real Chromium): Base UI's Select commits a pointer selection through a
// real PointerEvent, which jsdom in this project does not implement at all.
describe("CalcadaLabeledTimestampPicker", () => {
  it("shows '— live —' while no labeled timestamp is selected", () => {
    const harness = makeHarness();
    mount(harness);
    expect(triggerLabel()?.textContent).toBe("— live —");
  });

  it("uses the same trigger box as the other Graph tab dropdowns", () => {
    const harness = makeHarness();
    mount(harness);
    const classes = trigger().className.split(/\s+/);
    // The shared outline/sm trigger this control now uses instead of
    // SelectTrigger's own bigger default box (h-8/text-sm/light-mode
    // border-input) — `dark:border-input` is expected, it's part of the
    // shared outline variant's own dark-mode styling, not a leak of the old
    // default look.
    expect(classes).toContain("h-7");
    expect(classes).toContain("border-border");
    expect(classes).not.toContain("border-input");
    expect(classes).not.toContain("bg-transparent");
  });

  it("lists public and admin-visibility labels, marking admin ones", () => {
    const harness = makeHarness();
    mount(harness);
    openPanel();
    expect(optionElements().map((el) => el.textContent)).toEqual([
      "— live —",
      "Before merge",
      "After review (admins)",
    ]);
  });

  it("reflects a timestamp set from underneath it", () => {
    const harness = makeHarness();
    mount(harness);
    act(() => {
      harness.intermediateTimestamp.value = 2000;
    });
    expect(triggerLabel()?.textContent).toBe("After review (admins)");
  });

  it("falls back to '— live —' once a snapped-back timestamp no longer matches a label", () => {
    const harness = makeHarness();
    mount(harness);
    act(() => {
      harness.intermediateTimestamp.value = 4242;
    });
    expect(triggerLabel()?.textContent).toBe("— live —");
  });

  it("refreshes labeled timestamps when the panel opens", () => {
    const harness = makeHarness();
    mount(harness);
    expect(harness.refreshCount()).toBe(0);
    openPanel();
    expect(harness.refreshCount()).toBe(1);
  });

  it("still renders (with only '— live —') for a non-Calcada graph", () => {
    const harness = makeHarness();
    act(() => {
      root.render(
        createElement(CalcadaLabeledTimestampPicker, {
          graph: undefined,
          intermediateTimestamp: harness.intermediateTimestamp,
        }),
      );
    });
    expect(triggerLabel()?.textContent).toBe("— live —");
    openPanel();
    expect(optionElements().map((el) => el.textContent)).toEqual(["— live —"]);
  });
});
