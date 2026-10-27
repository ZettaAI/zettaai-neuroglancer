/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The 3D-preview toggle reads the host's watchables and writes through the
 * host method only. Written with `h` so it stays a `.spec.ts` in the jsdom
 * project, like `topbar_edit_button.spec.ts`.
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import type { PaintedVolumePreviewSummary } from "#src/editing/painted_volume/painted_volume_preview_summary.js";
import type { PaintedVolumePreviewToggleHost } from "#src/editing/ui/topbar/editing_topbar.js";
import { PaintedVolumePreviewToggle } from "#src/editing/ui/topbar/editing_topbar.js";
import { WatchableValue } from "#src/trackable_value.js";

class FakeHost implements PaintedVolumePreviewToggleHost {
  readonly paintedVolumePreviewEnabled = new WatchableValue(false);
  readonly paintedVolumePreviewSummary =
    new WatchableValue<PaintedVolumePreviewSummary>({ kind: "off" });
  setPaintedVolumePreviewEnabled(enabled: boolean): void {
    this.paintedVolumePreviewEnabled.value = enabled;
    this.paintedVolumePreviewSummary.value = enabled
      ? { kind: "waiting" }
      : { kind: "off" };
  }
}

let container: HTMLElement | undefined;

function mount(host: FakeHost) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    render(h(PaintedVolumePreviewToggle, { host }), container!);
  });
  const wrapper = container.querySelector(
    ".neuroglancer-painted-volume-toggle",
  ) as HTMLElement;
  const button = wrapper.querySelector("button") as HTMLButtonElement;
  return { wrapper, button };
}

afterEach(() => {
  if (container !== undefined) {
    render(null, container);
    container.remove();
    container = undefined;
  }
});

describe("PaintedVolumePreviewToggle", () => {
  it("turns the preview on and off through the host", () => {
    const host = new FakeHost();
    const { button } = mount(host);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    act(() => button.click());
    expect(host.paintedVolumePreviewEnabled.value).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("active")).toBe(true);
    act(() => button.click());
    expect(host.paintedVolumePreviewEnabled.value).toBe(false);
    expect(button.classList.contains("active")).toBe(false);
  });

  it("puts the tooltip on the wrapper and follows the summary", () => {
    const host = new FakeHost();
    const { wrapper } = mount(host);
    expect(wrapper.getAttribute("data-tooltip")).toMatch(/^Show painted/);
    act(() => {
      host.paintedVolumePreviewEnabled.value = true;
      host.paintedVolumePreviewSummary.value = {
        kind: "live",
        fill: { done: 1, total: 4, failed: 0 },
        textureBytes: 1024,
        factor: [1, 1, 1],
      };
    });
    expect(wrapper.getAttribute("data-tooltip")).toContain(
      "Loading 1 / 4 chunks",
    );
  });

  it("shows the downsampling next to the button", () => {
    const host = new FakeHost();
    const { wrapper } = mount(host);
    expect(
      wrapper.querySelector(".neuroglancer-painted-volume-toggle-downsample"),
    ).toBeNull();
    act(() => {
      host.paintedVolumePreviewEnabled.value = true;
      host.paintedVolumePreviewSummary.value = {
        kind: "live",
        fill: { done: 4, total: 4, failed: 0 },
        textureBytes: 1024,
        factor: [2, 2, 1],
      };
    });
    expect(
      wrapper.querySelector(".neuroglancer-painted-volume-toggle-downsample")
        ?.textContent,
    ).toBe("×2");
  });

  it("is disabled with the reason when the preview cannot exist", () => {
    const host = new FakeHost();
    const { wrapper, button } = mount(host);
    act(() => {
      host.paintedVolumePreviewEnabled.value = true;
      host.paintedVolumePreviewSummary.value = {
        kind: "unavailable",
        reason: "region-too-large",
      };
    });
    expect(button.disabled).toBe(true);
    expect(wrapper.getAttribute("data-tooltip")).toMatch(
      /^3D preview unavailable/,
    );
  });
});
