import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import {
  FilterParseError,
  printFilter,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import { libraryWith } from "#src/datasource/calcada/filter_library_fixture.js";
import { FilterEditor } from "#src/datasource/calcada/react/filter_editor.js";
import { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

let disposer: Disposer | undefined;
let element: HTMLElement;
let library: FilterLibrary;

afterEach(() => {
  if (disposer) invokeDisposer(disposer);
  element?.remove();
});

async function mount(text: string) {
  ({ library } = await libraryWith({ filter: text }));
  element = document.createElement("div");
  element.style.width = "420px";
  document.body.appendChild(element);
  disposer = mountComponent(element, FilterEditor, {
    library,
    state: new ZettaTraceState(),
  });
}

const current = () => printFilter(library.tree("filter")!);

async function find<T extends Element>(selector: string, index = 0) {
  return vi.waitFor(() => {
    const found = element.querySelectorAll<T & HTMLElement>(selector)[index];
    expect(found).toBeDefined();
    return found;
  });
}

async function button(label: string, index = 0) {
  return vi.waitFor(() => {
    const found = [
      ...element.querySelectorAll<HTMLButtonElement>("button"),
    ].filter(
      (candidate) =>
        candidate.textContent?.trim() === label ||
        candidate.getAttribute("aria-label") === label,
    )[index];
    expect(found).toBeDefined();
    return found;
  });
}

const optionLabels = (select: HTMLSelectElement) =>
  [...select.options].map((option) => option.text);

describe("FilterConditions", () => {
  it("leads with how the top rows combine", async () => {
    await mount("");
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        "No conditions yet, so every match passes.",
      ),
    );
    await mount("both size > 1k");
    await vi.waitFor(() =>
      expect(element.textContent).toContain("A match passes when:"),
    );
    await mount("both size > 1k and both axon > 10%");
    await vi.waitFor(() =>
      expect(element.textContent).toContain("of these hold:"),
    );
  });

  it("offers a row only Both, Seed or Candidate", async () => {
    await mount("seed size > 1k and both(axon > 10% or dendrite > 10%)");
    const rowTarget = await find<HTMLSelectElement>(
      ".calcada-filter-row .calcada-filter-target",
    );
    expect(optionLabels(rowTarget)).toEqual(["Both", "Seed", "Candidate"]);
    // The rows under both( … ) take its target and have no choice of their own.
    expect(element.querySelectorAll(".calcada-filter-target")).toHaveLength(2);
  });

  it("lets a group hand the choice to its rows", async () => {
    await mount("seed size > 1k and both(axon > 10% or dendrite > 10%)");
    const groupTarget = await find<HTMLSelectElement>(
      ".calcada-filter-row .calcada-filter-target",
      1,
    );
    expect(optionLabels(groupTarget)).toContain("Each row picks");
    await userEvent.selectOptions(groupTarget, "Each row picks");
    await vi.waitFor(() =>
      expect(current()).toBe(
        "seed size > 1k and (both axon > 10% or both dendrite > 10%)",
      ),
    );
  });

  it("adds a measure from the + Add menu and focuses it", async () => {
    await mount("both axon >= 30%");
    (await button("+ Add")).click();
    (await button("Measure (size, axon %, …)")).click();
    await vi.waitFor(() =>
      expect(current()).toBe("both axon >= 30% and both size > 20k"),
    );
    const rows = element.querySelectorAll(".calcada-filter-row");
    await vi.waitFor(() =>
      expect(rows[rows.length - 1].contains(document.activeElement)).toBe(true),
    );
  });

  it("duplicates a row", async () => {
    await mount("both axon >= 30%");
    (await button("Duplicate")).click();
    await vi.waitFor(() =>
      expect(current()).toBe("both axon >= 30% and both axon >= 30%"),
    );
  });

  it("removes the last row of a nested group, and the group with it", async () => {
    await mount("both axon >= 30% and both((size > 1k))");
    (await button("Remove", 2)).click();
    await vi.waitFor(() => expect(current()).toBe("both axon >= 30%"));
  });

  it("moves a row with Alt+arrows and says when it is already last", async () => {
    await mount("both axon >= 30% and both size > 1k");
    const handle = await find<HTMLButtonElement>(".calcada-filter-handle");
    handle.focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await vi.waitFor(() =>
      expect(current()).toBe("both size > 1k and both axon >= 30%"),
    );
    const moved = await find<HTMLButtonElement>(".calcada-filter-handle", 1);
    moved.focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        "Already the last row in this group",
      ),
    );
  });

  it("keeps a bad number as typed, with its hint, and holds Save", async () => {
    await mount("both size > 1k");
    const input = await find<HTMLInputElement>(".calcada-filter-number");
    await userEvent.clear(input);
    await userEvent.type(input, "abc{Enter}");
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        "Enter a size in voxels, like 20k or 20000",
      ),
    );
    expect(input.value).toBe("abc");
    expect(element.querySelector(".calcada-filter-status")?.textContent).toBe(
      "Fix value",
    );
    await userEvent.clear(input);
    await userEvent.type(input, "5k{Enter}");
    await vi.waitFor(() => expect(current()).toBe("both size > 5k"));
  });

  it("marks what differs from the saved version", async () => {
    await mount("both size > 1k");
    const input = await find<HTMLInputElement>(".calcada-filter-number");
    await userEvent.clear(input);
    await userEvent.type(input, "5k{Enter}");
    await vi.waitFor(() =>
      expect(element.querySelector(".calcada-filter-number.changed")).not.toBe(
        null,
      ),
    );
  });

  it("says the tree is the last parsed version while the text has an error", async () => {
    await mount("both size > 1k");
    library.setTextError(new FilterParseError("bad", 0, 1), "both size =");
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        "The text below has an error, so these conditions show the last version that parsed.",
      ),
    );
  });

  it("gives a score row no seed / candidate / both", async () => {
    await mount("score >= 0.5 and both size > 1k");
    const rows = await vi.waitFor(() => {
      const found = element.querySelectorAll(".calcada-filter-row");
      expect(found).toHaveLength(2);
      return found;
    });
    expect(rows[0].querySelector(".calcada-filter-target")).toBe(null);
    expect(rows[1].querySelector(".calcada-filter-target")).not.toBe(null);
  });

  it("closes the + Add menu on a click elsewhere or Escape", async () => {
    await mount("both axon >= 30%");
    const menu = () => element.querySelector(".calcada-filter-menu");
    (await button("+ Add")).click();
    await vi.waitFor(() => expect(menu()).not.toBe(null));
    await userEvent.click(
      element.querySelector(".calcada-filter-section-title")!,
    );
    await vi.waitFor(() => expect(menu()).toBe(null));
    (await button("+ Add")).click();
    await vi.waitFor(() => expect(menu()).not.toBe(null));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(menu()).toBe(null));
  });
});
