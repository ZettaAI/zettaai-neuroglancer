/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { ParamStatusOverlay } from "#src/editing/param_status_overlay.js";

/** The grey box neuroglancer wraps a modal status message in. */
const readoutBox = () =>
  document.querySelector<HTMLElement>(
    "#neuroglancer-status-container-modal > div",
  );

describe("ParamStatusOverlay", () => {
  // Each test disposes its overlay. The body is left alone: neuroglancer keeps
  // one status container for the page, and clearing it would detach it.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("colours the whole box in the segment's colour, with readable text", () => {
    const overlay = new ParamStatusOverlay();
    overlay.show("Value: 5", {
      tint: { background: "#ff8000", text: "black" },
    });
    overlay.show("Value: 6", {
      tint: { background: "#0000ff", text: "white" },
    });
    const box = readoutBox()!;
    expect(box.style.backgroundColor).toBe("rgb(0, 0, 255)");
    expect(box.style.color).toBe("white");
    expect(box.textContent).toContain("Value: 6");
    overlay.dispose();
  });

  it("keeps the usual box for value 0 and for a plain readout", () => {
    const overlay = new ParamStatusOverlay();
    overlay.show("Value: 5", {
      tint: { background: "#ff8000", text: "black" },
    });
    overlay.show("Value: 0", { tint: "none" });
    expect(readoutBox()!.style.backgroundColor).toBe("");
    overlay.show("Value: 5", {
      tint: { background: "#ff8000", text: "black" },
    });
    overlay.show("Size: 7");
    expect(readoutBox()!.style.backgroundColor).toBe("");
    expect(readoutBox()!.style.color).toBe("");
    overlay.dispose();
  });

  it("stays up for the time it is given", () => {
    vi.useFakeTimers();
    const overlay = new ParamStatusOverlay(1200);
    overlay.show("Value: 5", {
      tint: { background: "#ff8000", text: "black" },
      dismissAfterMs: 2000,
    });
    vi.advanceTimersByTime(1500);
    expect(readoutBox()).not.toBeNull();
    vi.advanceTimersByTime(600);
    expect(readoutBox()).toBeNull();
    overlay.dispose();
  });
});
