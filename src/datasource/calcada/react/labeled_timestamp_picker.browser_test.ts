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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CalcadaGraphSource,
  CalcadaLabeledTimestamp,
} from "#src/datasource/calcada/frontend.js";
import { CalcadaLabeledTimestampPicker } from "#src/datasource/calcada/react/labeled_timestamp_picker.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { TrackableValue, WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

const LABELS: CalcadaLabeledTimestamp[] = [
  { id: "1", label: "Before merge", timestampMs: 1000, visibility: "public" },
  { id: "2", label: "After review", timestampMs: 2000, visibility: "admin" },
];

let target: HTMLDivElement;
let disposer: Disposer;
let intermediateTimestamp: TrackableValue<number | undefined>;

beforeEach(() => {
  const graph = {
    labeledTimestamps: new WatchableValue<CalcadaLabeledTimestamp[]>([
      ...LABELS,
    ]),
    triggerLabeledTimestampRefresh: () => {},
  } as unknown as CalcadaGraphSource;
  intermediateTimestamp = new TrackableValue<number | undefined>(
    undefined,
    (x) => x,
  );
  target = document.createElement("div");
  document.body.appendChild(target);
  disposer = mountComponent(target, CalcadaLabeledTimestampPicker, {
    graph,
    intermediateTimestamp,
  });
});

afterEach(() => {
  invokeDisposer(disposer);
  target.remove();
});

function trigger() {
  return target.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
}

function options() {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
  ];
}

// createRoot().render commits asynchronously, and a loaded CI runner can take
// far longer to get there than any fixed delay allows — waiting on the
// trigger itself rather than on a stopwatch is what keeps this suite from
// flaking (mirrors branch_picker.browser_test.ts's pickerRendered()).
function pickerRendered() {
  return vi.waitFor(() => {
    if (trigger() === null) {
      throw new Error("CalcadaLabeledTimestampPicker has not rendered yet");
    }
  });
}

describe("CalcadaLabeledTimestampPicker in a real browser", () => {
  it("sets the intermediate timestamp when a label is picked", async () => {
    await pickerRendered();
    await userEvent.click(trigger());
    const option = options().find((el) => el.textContent === "Before merge")!;
    await userEvent.click(option);
    expect(intermediateTimestamp.value).toBe(1000);
  });

  it("clears the intermediate timestamp when '— live —' is picked", async () => {
    intermediateTimestamp.value = 1000;
    await pickerRendered();
    await userEvent.click(trigger());
    const option = options().find((el) => el.textContent === "— live —")!;
    await userEvent.click(option);
    expect(intermediateTimestamp.value).toBeUndefined();
  });
});
