import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import { printFilter } from "#src/datasource/calcada/candidate_filter_text.js";
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
  return vi.waitFor(() => {
    const found = element.querySelector<HTMLTextAreaElement>(
      ".calcada-filter-text textarea",
    );
    expect(found).not.toBe(null);
    return found!;
  });
}

const current = () => printFilter(library.tree("filter")!);
const status = () =>
  element.querySelector(".calcada-filter-parse")?.textContent ?? "";

async function button(label: string) {
  return vi.waitFor(() => {
    const found = [
      ...element.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent?.trim() === label);
    expect(found).toBeDefined();
    return found!;
  });
}

describe("FilterText", () => {
  it("shows the filter as text, in sync", async () => {
    const text = await mount("both axon >= 30%");
    expect(text.value).toBe("both axon >= 30%");
    await vi.waitFor(() =>
      expect(status()).toBe("✓ Text and conditions are in sync"),
    );
  });

  it("changes the tree as you type", async () => {
    const text = await mount("both axon >= 30%");
    await userEvent.clear(text);
    await userEvent.type(text, "both size > 20k");
    await vi.waitFor(() => expect(current()).toBe("both size > 20k"));
    expect(text.value).toBe("both size > 20k");
  });

  it("points at the word an error is about", async () => {
    const text = await mount("both axon >= 30%");
    await userEvent.clear(text);
    await userEvent.type(text, "both size = 3");
    await vi.waitFor(() =>
      expect(status()).toBe(
        "Line 1, column 11: There is no =; use <, <=, > or >=",
      ),
    );
    const marked = element.querySelector(".calcada-filter-token.error");
    expect(marked?.textContent).toBe("=");
    expect(current()).toBe("both axon >= 30%");
    expect(element.querySelector(".calcada-filter-status")?.textContent).toBe(
      "Text error",
    );
  });

  it("keeps comments through a number changed in the tree", async () => {
    const text = await mount("both size > 20k");
    await userEvent.clear(text);
    await userEvent.type(text, "both size > 20k  # small");
    await vi.waitFor(() =>
      expect(library.tree("filter")!.note).toBe("both size > 20k  # small"),
    );
    text.blur();
    const input = element.querySelector<HTMLInputElement>(
      ".calcada-filter-number",
    )!;
    await userEvent.clear(input);
    await userEvent.type(input, "5k{Enter}");
    await vi.waitFor(() => expect(text.value).toBe("both size > 5k  # small"));
  });

  it("drops comments when a change reprints the text, and says so", async () => {
    const text = await mount("both size > 20k");
    await userEvent.clear(text);
    await userEvent.type(text, "both size > 20k  # small");
    await vi.waitFor(() => expect(library.tree("filter")!.note).toBeDefined());
    text.blur();
    (await button("+ Add")).click();
    (await button("Measure (size, axon %, …)")).click();
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        "Your comments were taken out of the text because this change reprints it.",
      ),
    );
    expect(text.value).toBe("both size > 20k and both size > 20k");
  });

  it("reprints on Format", async () => {
    const text = await mount("both size > 20k");
    await userEvent.clear(text);
    await userEvent.type(text, "both   size>20k # x");
    await vi.waitFor(() => expect(library.tree("filter")!.note).toBeDefined());
    (await button("Format")).click();
    await vi.waitFor(() => expect(text.value).toBe("both size > 20k"));
  });

  it("saves what was just typed on Ctrl+S", async () => {
    const text = await mount("both axon >= 30%");
    await userEvent.clear(text);
    await userEvent.type(text, "both size > 20k");
    await userEvent.keyboard("{Control>}s{/Control}");
    await vi.waitFor(() =>
      expect(printFilter(library.saved("filter")!)).toBe("both size > 20k"),
    );
    await vi.waitFor(() =>
      expect(element.querySelector(".calcada-filter-status")?.textContent).toBe(
        "Saved",
      ),
    );
  });
});
