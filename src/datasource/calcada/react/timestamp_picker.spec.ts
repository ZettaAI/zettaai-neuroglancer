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

import { CalcadaTimestampPicker } from "#src/datasource/calcada/react/timestamp_picker.js";
import { TrackableValue, WatchableValue } from "#src/trackable_value.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EARLIEST = new Date("2026-01-01T00:00:00").valueOf();
const WITHIN_RANGE = new Date("2026-06-15T14:30:00").valueOf();

let container: HTMLDivElement;
let root: Root;
let intermediateTimestamp: TrackableValue<number | undefined>;
let timestampLimit: WatchableValue<number>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  intermediateTimestamp = new TrackableValue<number | undefined>(
    undefined,
    (x) => x,
  );
  timestampLimit = new WatchableValue<number>(EARLIEST);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mount() {
  act(() => {
    root.render(
      createElement(CalcadaTimestampPicker, {
        intermediateTimestamp,
        timestampLimit,
      }),
    );
  });
}

function trigger() {
  return container.querySelector<HTMLButtonElement>(
    '[data-slot="popover-trigger"]',
  )!;
}

function timeField() {
  return container.querySelector<HTMLInputElement>('input[type="time"]')!;
}

function clearButton() {
  return container.querySelector<HTMLButtonElement>(
    '[aria-label="Return to live"]',
  )!;
}

// React's value tracker swallows plain `input.value = x`; use the prototype setter.
const nativeInputValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

function typeTime(value: string) {
  act(() => {
    nativeInputValue.call(timeField(), value);
    timeField().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CalcadaTimestampPicker", () => {
  it("shows no date while no timestamp is set", () => {
    mount();
    expect(trigger().textContent).toBe("");
    expect(timeField().value).toBe("");
    expect(clearButton().disabled).toBe(true);
  });

  it("summarizes the pending timestamp on the trigger", () => {
    intermediateTimestamp.value = WITHIN_RANGE;
    mount();
    expect(trigger().textContent).toContain("2026-06-15 14:30:00");
    expect(timeField().value).toBe("14:30:00");
  });

  it("follows the watchable when the timestamp changes underneath it", () => {
    mount();
    act(() => {
      intermediateTimestamp.value = WITHIN_RANGE;
    });
    expect(trigger().textContent).toContain("2026-06-15 14:30:00");
  });

  it("applies a new time of day without moving the date", () => {
    intermediateTimestamp.value = WITHIN_RANGE;
    mount();
    typeTime("09:15:00");
    expect(intermediateTimestamp.value).toBe(
      new Date("2026-06-15T09:15:00").valueOf(),
    );
  });

  it("ignores a cleared time field rather than writing an invalid date", () => {
    intermediateTimestamp.value = WITHIN_RANGE;
    mount();
    typeTime("");
    expect(intermediateTimestamp.value).toBe(WITHIN_RANGE);
  });

  it("clamps a time earlier than the graph's limit up to the limit", () => {
    intermediateTimestamp.value = EARLIEST + 60 * 60 * 1000;
    mount();
    typeTime("00:00:00");
    expect(intermediateTimestamp.value).toBe(EARLIEST);
  });

  it("returns to live when cleared", () => {
    intermediateTimestamp.value = WITHIN_RANGE;
    mount();
    act(() => {
      clearButton().click();
    });
    expect(intermediateTimestamp.value).toBeUndefined();
    expect(trigger().textContent).toBe("");
  });

  it("opens a calendar limited to the selectable range", () => {
    intermediateTimestamp.value = WITHIN_RANGE;
    mount();
    act(() => {
      trigger().click();
    });
    const calendar = document.querySelector('[data-slot="calendar"]');
    expect(calendar).not.toBeNull();
    const selected = document.querySelector('[data-selected-single="true"]');
    expect(selected?.getAttribute("data-day")).toBe(
      new Date(WITHIN_RANGE).toLocaleDateString(),
    );
  });
});
