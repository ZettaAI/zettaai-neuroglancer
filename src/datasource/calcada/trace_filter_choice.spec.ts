import { describe, expect, it } from "vitest";
import {
  parseFilterText,
  printFilter,
} from "#src/datasource/calcada/candidate_filter_text.js";
import { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import type { FilterPreset } from "#src/datasource/calcada/filter_presets.js";
import { addRow } from "#src/datasource/calcada/filter_tree_edits.js";
import {
  chooseTraceFilter,
  followSavedTraceFilter,
} from "#src/datasource/calcada/trace_filter_choice.js";
import { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import { invokeDisposer } from "#src/util/disposable.js";

async function setUp() {
  const presets = new Map<string, FilterPreset>([
    [
      "1",
      {
        id: "1",
        name: "axons",
        tree: parseFilterText("both axon >= 30%"),
        updatedAt: "",
      },
    ],
  ]);
  const library = new FilterLibrary(
    {
      list: async () => [...presets.values()],
      create: async () => {
        throw new Error("unused");
      },
      update: async (id, change) => {
        const preset = { ...presets.get(id)!, ...change };
        presets.set(id, preset);
        return preset;
      },
      remove: async () => {},
    },
    { load: () => ({}), save: () => {} },
  );
  await library.load();
  library.select("axons");
  const state = new ZettaTraceState();
  return { library, state };
}

describe("the Trace filter", () => {
  it("is the saved version of the chosen filter", async () => {
    const { library, state } = await setUp();
    chooseTraceFilter(state, library, "axons");
    expect(state.filterPresetId.value).toBe("1");
    expect(printFilter(state.filter.value)).toBe("both axon >= 30%");
    chooseTraceFilter(state, library, undefined);
    expect(state.filterPresetId.value).toBeUndefined();
    expect(state.filter.value.children).toEqual([]);
  });

  it("follows a save, but never an unsaved edit", async () => {
    const { library, state } = await setUp();
    chooseTraceFilter(state, library, "axons");
    const stop = followSavedTraceFilter(state, library);
    library.edit(
      (root) => (addRow(root, root.id!, "cond"), root),
      "adding a measure",
    );
    expect(printFilter(state.filter.value)).toBe("both axon >= 30%");
    await library.save();
    expect(printFilter(state.filter.value)).toBe(
      "both axon >= 30% and both size > 20k",
    );
    invokeDisposer(stop);
  });

  it("keeps a linked filter the library does not have", async () => {
    const { library, state } = await setUp();
    state.filterPresetId.value = "99";
    state.filter.value = parseFilterText("both size > 1k");
    const stop = followSavedTraceFilter(state, library);
    library.edit((root) => root, "noop");
    expect(printFilter(state.filter.value)).toBe("both size > 1k");
    invokeDisposer(stop);
  });
});
