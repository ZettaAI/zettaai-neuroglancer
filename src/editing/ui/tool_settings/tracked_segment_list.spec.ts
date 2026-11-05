/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZExtrapolationSegmentRow } from "#src/editing/tool_runtimes/z_extrapolation_tool.js";
import { TrackedSegmentList } from "#src/editing/ui/tool_settings/tracked_segment_list.js";

let container: HTMLDivElement | undefined;

afterEach(() => {
  if (container !== undefined) {
    render(null, container);
    container.remove();
    container = undefined;
  }
});

function row(
  id: bigint,
  overrides: Partial<ZExtrapolationSegmentRow> = {},
): ZExtrapolationSegmentRow {
  return {
    id,
    isTracked: true,
    isHidden: false,
    isMerged: false,
    ...overrides,
  };
}

const ROWS = [
  row(100n),
  row(200n, { isTracked: false }),
  row(300n, { isHidden: true }),
  row(400n, { isMerged: true }),
];

/** Stands in for the host mounting NG's segment row: the ID in a marker div. */
function fakeMountSegment() {
  const unmounts = new Map<bigint, ReturnType<typeof vi.fn>>();
  const mountSegment = vi.fn((parent: HTMLElement, id: bigint) => {
    const element = document.createElement("div");
    element.className = "fake-native-row";
    element.textContent = String(id);
    parent.appendChild(element);
    const unmount = vi.fn(() => element.remove());
    unmounts.set(id, unmount);
    return unmount;
  });
  return { mountSegment, unmounts };
}

function mount(
  rows: readonly ZExtrapolationSegmentRow[] = ROWS,
  maxTracked = 255,
  native: {
    mountSegment: (parent: HTMLElement, id: bigint) => (() => void) | undefined;
  } = fakeMountSegment(),
) {
  const host = document.createElement("div");
  container = host;
  document.body.appendChild(host);
  const props = {
    rows,
    maxTracked,
    mountSegment: native.mountSegment,
    canAutoDetect: true,
    onAutoDetect: vi.fn(),
    onSetTracked: vi.fn(),
    onSetAllTracked: vi.fn(),
  };
  const rerender = (nextRows: readonly ZExtrapolationSegmentRow[]) =>
    act(() =>
      render(h(TrackedSegmentList, { ...props, rows: nextRows }), host),
    );
  rerender(rows);
  const rowElements = () => [
    ...host.querySelectorAll<HTMLElement>(".neuroglancer-tracked-segments-row"),
  ];
  const targets = () => [
    ...host.querySelectorAll<HTMLButtonElement>(
      ".neuroglancer-tracked-segments-target",
    ),
  ];
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find(
      (element) => element.textContent === text,
    )!;
  return { host, props, rowElements, targets, button, rerender };
}

describe("TrackedSegmentList", () => {
  it("shows each segment's id with its badges", () => {
    const { rowElements } = mount();
    expect(rowElements().map((element) => element.textContent)).toEqual([
      "100",
      "200",
      "300hidden",
      "400merged",
    ]);
  });

  it("shows NG's own segment row for each segment", () => {
    const native = fakeMountSegment();
    const { host } = mount(ROWS, 255, native);
    expect(native.mountSegment.mock.calls.map(([, id]) => id)).toEqual([
      100n,
      200n,
      300n,
      400n,
    ]);
    expect(host.querySelectorAll(".fake-native-row")).toHaveLength(4);
    // NG's row replaces the plain ID.
    expect(host.querySelector(".neuroglancer-tracked-segments-id")).toBe(null);
  });

  it("does not remount NG's rows on a re-render", () => {
    const native = fakeMountSegment();
    const { rerender } = mount(ROWS, 255, native);
    rerender(ROWS.map((entry) => ({ ...entry, isTracked: false })));
    expect(native.mountSegment).toHaveBeenCalledTimes(4);
  });

  it("unmounts NG's row when its segment leaves the list, and all on unmount", () => {
    const native = fakeMountSegment();
    const { host, rerender } = mount(ROWS, 255, native);
    rerender([row(100n), row(300n)]);
    expect(native.unmounts.get(200n)).toHaveBeenCalledTimes(1);
    expect(native.unmounts.get(400n)).toHaveBeenCalledTimes(1);
    expect(native.unmounts.get(100n)).not.toHaveBeenCalled();
    act(() => render(null, host));
    expect(native.unmounts.get(100n)).toHaveBeenCalledTimes(1);
    expect(native.unmounts.get(300n)).toHaveBeenCalledTimes(1);
  });

  it("shows the plain id while NG's row cannot be mounted", () => {
    const { host } = mount([row(100n)], 255, {
      mountSegment: vi.fn(() => undefined),
    });
    expect(
      host.querySelector(".neuroglancer-tracked-segments-id")!.textContent,
    ).toBe("100");
  });

  it("shows tracking as a pressed toggle, not a checkbox", () => {
    const { host, targets } = mount();
    expect(host.querySelector("input[type=checkbox]")).toBe(null);
    expect(
      targets().map((element) => element.getAttribute("aria-pressed")),
    ).toEqual(["true", "false", "true", "true"]);
  });

  it("counts tracked of listed segments", () => {
    const { host } = mount();
    expect(
      host.querySelector(".neuroglancer-tracked-segments-head span")!
        .textContent,
    ).toBe("Tracking 3 of 4");
  });

  it("toggles tracking when a crosshair is clicked", () => {
    const { targets, props } = mount();
    act(() => targets()[1].click());
    expect(props.onSetTracked).toHaveBeenCalledWith(200n, true);
    act(() => targets()[0].click());
    expect(props.onSetTracked).toHaveBeenCalledWith(100n, false);
  });

  it("tracks or untracks all with the bulk buttons", () => {
    const { button, props } = mount();
    act(() => button("All").click());
    act(() => button("None").click());
    expect(props.onSetAllTracked.mock.calls).toEqual([[true], [false]]);
  });

  it("disables the bulk button that would change nothing", () => {
    const { button } = mount([row(1n), row(2n)]);
    expect(button("All").disabled).toBe(true);
    expect(button("None").disabled).toBe(false);
  });

  it("warns when more segments are tracked than one run carries", () => {
    const { host } = mount(ROWS, 2);
    expect(
      host.querySelector(".neuroglancer-tracked-segments-limit")!.textContent,
    ).toBe("At most 2 segments per run — untrack 1 more.");
  });

  it("shows no limit warning within the limit", () => {
    const { host } = mount();
    expect(host.querySelector(".neuroglancer-tracked-segments-limit")).toBe(
      null,
    );
  });

  it("shows how to add segments when the list is empty", () => {
    const { host } = mount([]);
    expect(
      host.querySelector(".neuroglancer-tracked-segments-empty")!.textContent,
    ).toBe("Double-click segments in the viewer, or use Auto-detect.");
  });
});
