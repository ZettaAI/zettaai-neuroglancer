import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import type { PanelKind } from "#src/datasource/calcada/point_placement.js";
import { PointPlacement } from "#src/datasource/calcada/point_placement.js";
import { NullarySignal } from "#src/util/signal.js";

let placement: PointPlacement | undefined;
let container: HTMLDivElement;

afterEach(() => {
  placement?.dispose();
  container?.remove();
});

function setUp() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const slice = { element: document.createElement("div") };
  const perspective = { element: document.createElement("div") };
  container.append(slice.element, perspective.element);
  const kinds = new Map<object, PanelKind>([
    [slice, "2d"],
    [perspective, "3d"],
  ]);
  const display = {
    container,
    panels: new Set([slice, perspective]),
    updateFinished: new NullarySignal(),
  };
  placement = new PointPlacement(display, (panel) => kinds.get(panel));
  return { slice, perspective, display, kinds };
}

describe("PointPlacement", () => {
  it("marks 2D and 3D panels and shows what to do", async () => {
    const { slice, perspective } = setUp();
    placement!.begin({
      message: "Click a segment in a 2D view",
      onCancel: () => {},
    });
    expect(slice.element.classList.contains("calcada-placing-point-2d")).toBe(
      true,
    );
    expect(
      perspective.element.classList.contains("calcada-placing-point-3d"),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Click a segment in a 2D view"),
    );
    expect(container.textContent).toContain("Esc to cancel");
    placement!.end();
    expect(slice.element.classList.contains("calcada-placing-point-2d")).toBe(
      false,
    );
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain("Click a segment"),
    );
  });

  it("marks a panel that appears while placing", () => {
    const { display, kinds } = setUp();
    placement!.begin({ message: "x", onCancel: () => {} });
    const late = { element: document.createElement("div") };
    display.panels.add(late);
    kinds.set(late, "2d");
    display.updateFinished.dispatch();
    expect(late.element.classList.contains("calcada-placing-point-2d")).toBe(
      true,
    );
  });

  it("ends on Escape and tells its owner", async () => {
    setUp();
    let cancelled = 0;
    placement!.begin({ message: "x", onCancel: () => cancelled++ });
    await userEvent.keyboard("{Escape}");
    expect(cancelled).toBe(1);
    expect(placement!.active).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(cancelled).toBe(1);
  });
});
