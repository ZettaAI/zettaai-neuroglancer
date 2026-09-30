import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import { printFilter } from "#src/datasource/calcada/candidate_filter_text.js";
import type { GroupNode } from "#src/datasource/calcada/candidate_filter_tree.js";
import { registerFilterEditorPanel } from "#src/datasource/calcada/filter_editor_panel.js";
import { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import { libraryWith } from "#src/datasource/calcada/filter_library_fixture.js";
import { addRow } from "#src/datasource/calcada/filter_tree_edits.js";
import { FilterEditor } from "#src/datasource/calcada/react/filter_editor.js";
import {
  FILTER_EDITOR_MIN_WIDTH_PX,
  FILTER_EDITOR_WIDTH_PX,
  ZettaTraceState,
} from "#src/datasource/calcada/trace_state.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type {
  RegisteredSidePanel,
  SidePanelManager,
} from "#src/ui/side_panel.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

let disposer: Disposer | undefined;
let element: HTMLElement | undefined;

afterEach(() => {
  if (disposer) invokeDisposer(disposer);
  element?.remove();
});

function emptyLibrary() {
  return new FilterLibrary(
    {
      list: async () => [],
      create: async () => {
        throw new Error("unused");
      },
      update: async () => {
        throw new Error("unused");
      },
      remove: async () => {},
    },
    { load: () => ({}), save: () => {} },
  );
}

describe("filter editor panel", () => {
  it("registers at the trace state's location and mounts the editor", async () => {
    const registered: RegisteredSidePanel[] = [];
    const manager = {
      registerPanel: (panel: RegisteredSidePanel) => {
        registered.push(panel);
        return () => {};
      },
    } as unknown as SidePanelManager;
    const state = new ZettaTraceState();
    disposer = registerFilterEditorPanel(manager, state, emptyLibrary());
    expect(registered).toHaveLength(1);
    expect(registered[0].location).toBe(state.filterEditor);
    const panel = registered[0].makePanel();
    element = panel.element;
    document.body.appendChild(element);
    await vi.waitFor(() =>
      expect(element!.querySelector(".calcada-filter-editor")).not.toBe(null),
    );
    panel.close();
    expect(state.filterEditor.visible).toBe(false);
    panel.dispose();
  });
});

const AXON_TEXT = `both(
  (size < 20k
   and no neighbors within 3 hops with (size > 200k and dendrite > 80%))
  or (size from 20k to 60k and axon >= 10%
      and no neighbors within 2 hops with (size > 200k and dendrite > 80%))
  or (size > 60k and axon >= 30%)
)`;

async function mountEditor(
  filters: Record<string, string> = { axons: "both axon >= 30%" },
  width = FILTER_EDITOR_WIDTH_PX,
) {
  const { library, calls, client } = await libraryWith(filters);
  const state = new ZettaTraceState();
  element = document.createElement("div");
  element.style.width = `${width}px`;
  document.body.appendChild(element);
  disposer = mountComponent(element, FilterEditor, { library, state });
  return { library, calls, client, state };
}

async function button(label: string) {
  return vi.waitFor(() => {
    const found = [
      ...element!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent?.trim() === label);
    expect(found).toBeDefined();
    return found!;
  });
}

const statusText = () =>
  element!.querySelector(".calcada-filter-status")?.textContent;

const addSize = (root: GroupNode) => (addRow(root, root.id!, "cond"), root);

describe("FilterEditor", () => {
  it("shows Saved, then Unsaved after an edit, and saves", async () => {
    const { library, calls } = await mountEditor();
    await vi.waitFor(() => expect(statusText()).toBe("Saved"));
    expect((await button("Save")).disabled).toBe(true);
    library.edit(addSize, "adding a measure");
    await vi.waitFor(() => expect(statusText()).toBe("Unsaved"));
    const save = await button("Save");
    expect(save.disabled).toBe(false);
    save.click();
    await vi.waitFor(() => expect(calls).toEqual(["update 1"]));
    await vi.waitFor(() => expect(statusText()).toBe("Saved"));
  });

  it("names a copy before creating it, and says where the edits went", async () => {
    const { library, calls } = await mountEditor();
    library.edit(addSize, "adding a measure");
    (await button("Save as new…")).click();
    const input = await vi.waitFor(() => {
      const found = element!.querySelector<HTMLInputElement>(
        ".calcada-filter-rename input",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    expect(input.value).toBe("axons copy");
    expect(element!.textContent).toContain(
      "Your unsaved edits go into it; “axons” stays as it was saved.",
    );
    (await button("Use this name")).click();
    await vi.waitFor(() => expect(calls).toEqual(["create axons copy"]));
    expect(library.current).toBe("axons copy");
    expect(library.isDirty("axons")).toBe(false);
  });

  it("refuses a name another filter has", async () => {
    await mountEditor({
      axons: "both axon >= 30%",
      dendrites: "both dendrite > 80%",
    });
    (await button("⋯")).click();
    (await button("Rename…")).click();
    const input = await vi.waitFor(() => {
      const found = element!.querySelector<HTMLInputElement>(
        ".calcada-filter-rename input",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    await userEvent.fill(input, "Dendrites");
    (await button("Rename")).click();
    await vi.waitFor(() =>
      expect(element!.textContent).toContain(
        "Another filter already has that name",
      ),
    );
  });

  it("asks before deleting and says when Trace uses the filter", async () => {
    const { library, calls, state } = await mountEditor();
    state.filterPresetId.value = library.presetId("axons");
    (await button("⋯")).click();
    (await button("Delete…")).click();
    await vi.waitFor(() =>
      expect(element!.textContent).toContain(
        "Delete “axons”? The Trace tab uses it and will switch to no filter.",
      ),
    );
    (await button("Delete")).click();
    await vi.waitFor(() => expect(calls).toEqual(["remove 1"]));
    await vi.waitFor(() => expect(state.filterPresetId.value).toBeUndefined());
  });

  it("puts the saved filter to use in Trace", async () => {
    const { library, state } = await mountEditor();
    (await button("Use in Trace")).click();
    await vi.waitFor(() =>
      expect(state.filterPresetId.value).toBe(library.presetId("axons")),
    );
    expect(printFilter(state.filter.value)).toBe("both axon >= 30%");
    await vi.waitFor(() =>
      expect(element!.querySelector(".calcada-filter-badge")?.textContent).toBe(
        "Used by Trace",
      ),
    );
    library.edit(addSize, "adding a measure");
    await vi.waitFor(() =>
      expect(element!.querySelector(".calcada-filter-badge")?.textContent).toBe(
        "Trace uses the saved version",
      ),
    );
  });

  it("undoes and redoes edits", async () => {
    const { library } = await mountEditor();
    library.edit(addSize, "adding a measure");
    (await button("↶ Undo edit")).click();
    await vi.waitFor(() => expect(library.isDirty("axons")).toBe(false));
    (await button("↷ Redo edit")).click();
    await vi.waitFor(() => expect(library.isDirty("axons")).toBe(true));
  });

  it("fits its narrowest width with Sergiy's axon filter", async () => {
    await mountEditor(
      { "axon continuation": AXON_TEXT },
      FILTER_EDITOR_MIN_WIDTH_PX,
    );
    await vi.waitFor(() => expect(statusText()).toBe("Saved"));
    expect(element!.scrollWidth).toBeLessThanOrEqual(element!.clientWidth);
  });

  it("says when a save fails", async () => {
    const { library, client } = await mountEditor();
    client.update = async () => {
      throw new Error("offline");
    };
    library.edit(addSize, "adding a measure");
    (await button("Save")).click();
    await vi.waitFor(() =>
      expect(element!.textContent).toContain("Save failed: Error: offline"),
    );
    expect(library.isDirty("axons")).toBe(true);
  });

  it("says when a delete fails", async () => {
    const { client } = await mountEditor();
    client.remove = async () => {
      throw new Error("offline");
    };
    (await button("⋯")).click();
    (await button("Delete…")).click();
    (await button("Delete")).click();
    await vi.waitFor(() =>
      expect(element!.textContent).toContain("Delete failed: Error: offline"),
    );
  });

  it("says when the library could not be loaded, and retries", async () => {
    const { library, client } = await libraryWith({
      axons: "both axon >= 30%",
    });
    const list = client.list;
    client.list = async () => {
      throw new Error("offline");
    };
    await library.load().catch(() => {});
    element = document.createElement("div");
    document.body.appendChild(element);
    disposer = mountComponent(element, FilterEditor, {
      library,
      state: new ZettaTraceState(),
    });
    await vi.waitFor(() =>
      expect(element!.textContent).toContain(
        "Could not load your filters: Error: offline",
      ),
    );
    client.list = list;
    (await button("Retry")).click();
    await vi.waitFor(() => expect(library.loadError).toBeUndefined());
  });

  it("grows the text box with its wrapped lines at the narrowest width", async () => {
    await mountEditor(
      { "axon continuation": AXON_TEXT },
      FILTER_EDITOR_MIN_WIDTH_PX,
    );
    const text = await vi.waitFor(() => {
      const found = element!.querySelector<HTMLTextAreaElement>(
        ".calcada-filter-text textarea",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    await vi.waitFor(() =>
      expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1),
    );
  });

  it("closes the ⋯ menu on a click elsewhere", async () => {
    await mountEditor();
    (await button("⋯")).click();
    await vi.waitFor(() =>
      expect(element!.querySelector(".calcada-filter-menu")).not.toBe(null),
    );
    await userEvent.click(
      element!.querySelector(".calcada-filter-editor-title")!,
    );
    await vi.waitFor(() =>
      expect(element!.querySelector(".calcada-filter-menu")).toBe(null),
    );
  });

  it("leaves the Trace filter alone when another filter is opened", async () => {
    const { library, state } = await mountEditor({
      axons: "both axon >= 30%",
      dendrites: "both dendrite > 80%",
    });
    state.filterPresetId.value = library.presetId("axons");
    const select = await vi.waitFor(() => {
      const found = element!.querySelector<HTMLSelectElement>(
        ".calcada-filter-library-select",
      );
      expect(found).not.toBe(null);
      return found!;
    });
    await userEvent.selectOptions(select, "dendrites");
    await vi.waitFor(() => expect(library.current).toBe("dendrites"));
    expect(state.filterPresetId.value).toBe(library.presetId("axons"));
  });
});
