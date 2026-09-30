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

// The field is sized to its own text, so it has to be measured in the font the
// tab actually renders: `.nge-ui` picks it up from `--nge-font`, which only
// these tokens define.
import "#src/editing/ui/editing_theme.css";
import "#src/datasource/calcada/calcada.css";

import { CalcadaTimestampPicker } from "#src/datasource/calcada/react/timestamp_picker.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { TrackableValue, WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

let target: HTMLDivElement;
let disposer: Disposer;

beforeEach(() => {
  const intermediateTimestamp = new TrackableValue<number | undefined>(
    new Date("2026-06-15T09:00:00").valueOf(),
    (x) => x,
  );
  const timestampLimit = new WatchableValue<number>(
    new Date("2026-01-01T00:00:00").valueOf(),
  );
  target = document.createElement("div");
  // The real constraint this is guarding against: a side panel narrower than
  // the date trigger, time field, and reset button combined.
  target.style.cssText =
    "position: fixed; top: 100px; left: 100px; width: 140px;";
  document.body.appendChild(target);
  disposer = mountComponent(target, CalcadaTimestampPicker, {
    intermediateTimestamp,
    timestampLimit,
  });
});

afterEach(() => {
  invokeDisposer(disposer);
  target.remove();
});

function row() {
  return target.querySelector<HTMLElement>(
    ".neuroglancer-calcada-timestamp-picker",
  )!;
}

function dateTrigger() {
  return target.querySelector<HTMLElement>('[data-slot="popover-trigger"]')!;
}

function timeField() {
  return target.querySelector<HTMLInputElement>('input[type="time"]')!;
}

function resetButton() {
  return target.querySelector<HTMLElement>('[aria-label="Return to live"]')!;
}

// createRoot().render commits asynchronously, and a loaded CI runner can take
// far longer to get there than any fixed delay allows — waiting on the
// trigger itself rather than on a stopwatch is what keeps this suite from
// flaking (mirrors branch_picker.browser_test.ts's pickerRendered()).
function pickerRendered() {
  return vi.waitFor(() => {
    if (dateTrigger() === null) {
      throw new Error("CalcadaTimestampPicker has not rendered yet");
    }
  });
}

describe("CalcadaTimestampPicker in a narrow panel", () => {
  it("wraps the date trigger onto its own line instead of overflowing", async () => {
    await pickerRendered();
    const rowRect = row().getBoundingClientRect();
    const dateRect = dateTrigger().getBoundingClientRect();
    const timeRect = timeField().getBoundingClientRect();
    const resetRect = resetButton().getBoundingClientRect();

    // Nothing sticks out past the row's own box — the old `flex: 1 1 auto`
    // (no wrap) let the date trigger, time field, and reset button overflow
    // it instead.
    expect(dateRect.right).toBeLessThanOrEqual(rowRect.right + 1);
    expect(timeRect.right).toBeLessThanOrEqual(rowRect.right + 1);
    expect(resetRect.right).toBeLessThanOrEqual(rowRect.right + 1);

    // The date trigger (the only one with no fixed basis) wraps to its own
    // line; the fixed-width time field and reset button share the line below.
    expect(dateRect.bottom).toBeLessThanOrEqual(timeRect.top + 1);
    expect(Math.abs(timeRect.top - resetRect.top)).toBeLessThan(4);
  });

  it("lets the time field size itself to the segments it renders", async () => {
    await pickerRendered();
    const field = timeField();

    // Compared against the control's own intrinsic width, never a digit
    // string of our own: a time input renders in the browser's locale, so a
    // 12-hour one lays out an AM/PM segment that "13:45:59" would not
    // predict. A fixed width — too wide like the `w-28` this replaced, or too
    // narrow to hold a meridiem — is exactly what this catches, in whichever
    // locale the suite happens to run.
    const probe = field.cloneNode(true) as HTMLInputElement;
    probe.value = field.value;
    probe.style.width = "auto";
    field.parentElement!.appendChild(probe);
    const intrinsic = probe.getBoundingClientRect().width;
    probe.remove();

    expect(field.getBoundingClientRect().width).toBeCloseTo(intrinsic, 0);
  });
});

describe("CalcadaTimestampPicker reset with partial input", () => {
  let intermediateTimestamp: TrackableValue<number | undefined>;

  function mount(initial: number | undefined) {
    intermediateTimestamp = new TrackableValue<number | undefined>(
      initial,
      (x) => x,
    );
    const timestampLimit = new WatchableValue<number>(
      new Date("2026-01-01T00:00:00").valueOf(),
    );
    target = document.createElement("div");
    document.body.appendChild(target);
    disposer = mountComponent(target, CalcadaTimestampPicker, {
      intermediateTimestamp,
      timestampLimit,
    });
  }

  async function badInputAppears() {
    await vi.waitFor(() => {
      if (!timeField().validity.badInput) {
        throw new Error("the field has not registered a partial edit yet");
      }
    });
  }

  async function resetButtonEnabled() {
    await vi.waitFor(() => {
      if (resetButton().hasAttribute("disabled")) {
        throw new Error("the reset button has not enabled yet");
      }
    });
  }

  it("enables the reset button for a partial, not-yet-valid edit even while already live", async () => {
    mount(undefined);
    await pickerRendered();
    expect(resetButton().hasAttribute("disabled")).toBe(true);

    await userEvent.click(timeField());
    // Only the hour segment — never a complete, committable time.
    await userEvent.keyboard("09");
    await badInputAppears();
    await resetButtonEnabled();
    expect(intermediateTimestamp.value).toBeUndefined();

    await userEvent.click(resetButton());
    expect(intermediateTimestamp.value).toBeUndefined();
    expect(timeField().value).toBe("");
    expect(resetButton().hasAttribute("disabled")).toBe(true);
  });
});
