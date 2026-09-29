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
import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import type { FilterGroup } from "#src/datasource/calcada/candidate_filter_tree.js";
import type { FilterPreset } from "#src/datasource/calcada/filter_presets.js";
import { FilterPresetNameTakenError } from "#src/datasource/calcada/filter_presets.js";
import { FilterPresetBar } from "#src/datasource/calcada/react/filter_preset_bar.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

const editing: FilterGroup = {
  kind: "group",
  op: "and",
  children: [
    { kind: "condition", field: { measure: "score" }, cmp: ">=", value: 0.5 },
  ],
};
const saved: FilterGroup = { kind: "group", op: "or", children: [] };
const presets: FilterPreset[] = [
  { id: "1", name: "axons", tree: saved, updatedAt: "" },
  { id: "2", name: "dendrites", tree: saved, updatedAt: "" },
];

let host: HTMLDivElement;
let disposer: Disposer;

afterEach(() => {
  invokeDisposer(disposer);
  host.remove();
});

async function button(label: string) {
  return vi.waitFor(() => {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === label,
    );
    expect(found).toBeDefined();
    return found!;
  });
}

describe("FilterPresetBar", () => {
  it("refuses a rename onto another preset's name without touching it", async () => {
    const update = vi.fn(async (_id: string, change: { name?: string }) => {
      throw new FilterPresetNameTakenError(change.name ?? "");
    });
    host = document.createElement("div");
    host.style.cssText = "width: 260px;";
    document.body.appendChild(host);
    disposer = mountComponent(host, FilterPresetBar, {
      presets,
      store: {
        create: vi.fn(),
        update,
        remove: vi.fn(),
      },
      tree: editing,
      selectedId: "1",
      onSelect: () => {},
      onChanged: () => {},
    });

    (await button("Rename")).click();
    const input = await vi.waitFor(() => {
      const found = host.querySelector<HTMLInputElement>(
        'input[placeholder="Preset name"]',
      );
      expect(found).not.toBe(null);
      return found!;
    });
    await userEvent.clear(input);
    await userEvent.type(input, "dendrites");
    (await button("OK")).click();

    await vi.waitFor(() => expect(host.textContent).toContain("already named"));
    expect(
      [...host.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Overwrite",
      ),
    ).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("1", { name: "dendrites" });
  });
});
