import { describe, expect, it } from "vitest";
import {
  FilterParseError,
  parseFilterText,
  printFilter,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type { GroupNode } from "#src/datasource/calcada/candidate_filter_tree.js";
import type {
  FilterDraftStore,
  StoredDraft,
} from "#src/datasource/calcada/filter_library.js";
import {
  FilterLibrary,
  HISTORY_LIMIT,
} from "#src/datasource/calcada/filter_library.js";
import type { FilterPreset } from "#src/datasource/calcada/filter_presets.js";
import { addRow } from "#src/datasource/calcada/filter_tree_edits.js";

const AXONS = "both axon >= 30%";

function fakeClient(initial: Record<string, string> = { axons: AXONS }) {
  let nextId = 1;
  const presets = new Map<string, FilterPreset>();
  for (const [name, text] of Object.entries(initial)) {
    const id = String(nextId++);
    presets.set(id, { id, name, tree: parseFilterText(text), updatedAt: "" });
  }
  const calls: string[] = [];
  return {
    presets,
    calls,
    list: async () => [...presets.values()],
    create: async (name: string, tree: GroupNode) => {
      calls.push(`create ${name}`);
      const id = String(nextId++);
      const preset = { id, name, tree, updatedAt: "" };
      presets.set(id, preset);
      return preset;
    },
    update: async (id: string, change: { name?: string; tree?: GroupNode }) => {
      calls.push(`update ${id}`);
      const preset = { ...presets.get(id)!, ...change };
      presets.set(id, preset);
      return preset;
    },
    remove: async (id: string) => {
      calls.push(`remove ${id}`);
      presets.delete(id);
    },
  };
}

function memoryStore(): FilterDraftStore & {
  data: Record<string, StoredDraft>;
} {
  const store = {
    data: {} as Record<string, StoredDraft>,
    load: () => store.data,
    save: (drafts: Record<string, StoredDraft>) => {
      store.data = JSON.parse(JSON.stringify(drafts));
    },
  };
  return store;
}

const addSize = (root: GroupNode) => (addRow(root, root.id!, "cond"), root);

async function loaded(
  client = fakeClient(),
  store: FilterDraftStore = memoryStore(),
) {
  const library = new FilterLibrary(client, store);
  await library.load();
  library.select("axons");
  return library;
}

describe("FilterLibrary", () => {
  it("keeps an edit as a draft until saved, then the saved version matches", async () => {
    const client = fakeClient();
    const library = await loaded(client);
    expect(library.status).toBe("saved");
    library.edit(addSize, "adding a measure");
    expect(library.isDirty("axons")).toBe(true);
    expect(library.status).toBe("unsaved");
    expect(library.canSave()).toBe(true);
    await library.save();
    expect(client.calls).toEqual(["update 1"]);
    expect(library.isDirty("axons")).toBe(false);
    expect(printFilter(library.saved("axons")!)).toBe(
      "both axon >= 30% and both size > 20k",
    );
  });

  it("reverts a draft", async () => {
    const library = await loaded();
    library.edit(addSize, "adding a measure");
    library.revert();
    expect(library.isDirty("axons")).toBe(false);
    expect(printFilter(library.tree("axons")!)).toBe(AXONS);
  });

  it("refuses to save while the text has an error", async () => {
    const library = await loaded();
    library.edit(addSize, "adding a measure");
    library.setTextError(new FilterParseError("bad", 0, 1), "both size =");
    expect(library.status).toBe("text-error");
    expect(library.canSave()).toBe(false);
    library.setTextError(undefined);
    library.setBadValue("x|value", { raw: "abc", message: "bad" });
    expect(library.status).toBe("fix-value");
    expect(library.canSave()).toBe(false);
  });

  it("parks a broken text draft per filter and restores it", async () => {
    const library = await loaded(
      fakeClient({ axons: AXONS, dendrites: "both dendrite > 80%" }),
    );
    library.setTextError(new FilterParseError("bad", 0, 1), "both size =");
    library.select("dendrites");
    expect(library.textError).toBeUndefined();
    library.select("axons");
    expect(library.textDraft).toBe("both size =");
    expect(library.textError?.message).toBe("bad");
  });

  it("keeps drafts across a reload", async () => {
    const store = memoryStore();
    const first = await loaded(fakeClient(), store);
    first.edit(addSize, "adding a measure");
    const second = await loaded(fakeClient(), store);
    expect(second.isDirty("axons")).toBe(true);
  });

  it("drops a draft that edits its way back to the saved filter", async () => {
    const store = memoryStore();
    const library = await loaded(fakeClient(), store);
    library.edit(addSize, "adding a measure");
    library.edit(
      (root) => ({ ...root, children: root.children.slice(0, 1) }),
      "removing a row",
    );
    expect(library.isDirty("axons")).toBe(false);
    expect(store.data).toEqual({});
  });

  it("save as new puts the edits into a new filter and keeps the original saved", async () => {
    const client = fakeClient();
    const library = await loaded(client);
    library.edit(addSize, "adding a measure");
    await library.saveAsNew(library.uniqueName("axons"));
    expect(library.current).toBe("axons 2");
    expect(library.isDirty("axons")).toBe(false);
    expect(printFilter(library.saved("axons 2")!)).toBe(
      "both axon >= 30% and both size > 20k",
    );
  });

  it("names new filters uniquely, ignoring case", async () => {
    const library = await loaded(
      fakeClient({ axons: AXONS, "Axons 2": AXONS }),
    );
    expect(library.uniqueName("AXONS")).toBe("AXONS 3");
    expect(library.uniqueName("new filter")).toBe("new filter");
  });

  it("creates an empty filter and selects it", async () => {
    const library = await loaded();
    await library.createNew("new filter");
    expect(library.current).toBe("new filter");
    expect(library.tree("new filter")!.children).toEqual([]);
  });

  it("undo and redo walk the history, keeping at most the limit", async () => {
    const library = await loaded();
    library.edit(addSize, "adding a measure");
    expect(library.undo()).toBe("adding a measure");
    expect(library.isDirty("axons")).toBe(false);
    expect(library.redo()).toBe("adding a measure");
    expect(library.isDirty("axons")).toBe(true);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      library.edit(addSize, `step ${i}`);
    }
    let undone = 0;
    while (library.canUndo) {
      library.undo();
      undone++;
    }
    expect(undone).toBe(HISTORY_LIMIT);
  });

  it("renames and deletes on the server", async () => {
    const client = fakeClient();
    const library = await loaded(client);
    library.edit(addSize, "adding a measure");
    await library.rename("thin axons");
    expect(library.current).toBe("thin axons");
    expect(library.isDirty("thin axons")).toBe(true);
    await library.remove();
    expect(library.names).toEqual([]);
    expect(library.current).toBeUndefined();
    expect(client.calls).toEqual(["update 1", "remove 1"]);
  });

  it("survives a store that throws", async () => {
    const throwing: FilterDraftStore = {
      load: () => {
        throw new Error("denied");
      },
      save: () => {
        throw new Error("denied");
      },
    };
    const library = await loaded(fakeClient(), throwing);
    library.edit(addSize, "adding a measure");
    expect(library.current).toBe("axons");
    expect(library.isDirty("axons")).toBe(true);
  });

  it("drops a comment that no longer says what the tree says, and says so", async () => {
    const library = await loaded(fakeClient({ axons: "both axon >= 30%" }));
    library.setNote("both axon >= 30%  # thin");
    expect(library.tree("axons")!.note).toBe("both axon >= 30%  # thin");
    expect(library.edit(addSize, "adding a measure")).toEqual({
      noteDropped: true,
    });
    expect(library.tree("axons")!.note).toBeUndefined();
  });

  it("lets a tree edit replace text that had an error", async () => {
    const library = await loaded();
    library.setTextError(new FilterParseError("bad", 0, 1), "both size >");
    library.edit(addSize, "adding a measure");
    expect(library.textError).toBeUndefined();
    expect(library.textDraft).toBeUndefined();
  });

  it("forgets an invalid number once its row is gone or the edit is undone", async () => {
    const library = await loaded();
    library.edit(addSize, "adding a measure");
    const row = library.tree("axons")!.children[1].id!;
    library.setBadValue(`${row}|value`, { raw: "abc", message: "bad" });
    expect(library.status).toBe("fix-value");
    library.edit(
      (root) => ({ ...root, children: root.children.slice(0, 1) }),
      "removing a row",
    );
    expect(library.status).toBe("saved");
    library.undo();
    library.setBadValue(`${row}|value`, { raw: "abc", message: "bad" });
    library.undo();
    expect(library.badValue(`${row}|value`)).toBeUndefined();
  });

  it("keeps edits made while a save is on its way", async () => {
    const client = fakeClient();
    let finish: () => void = () => {};
    const update = client.update;
    client.update = (id, change) =>
      new Promise((resolve) => {
        finish = () => resolve(update(id, change));
      });
    const library = await loaded(client);
    library.edit(addSize, "adding a measure");
    const saving = library.save();
    library.edit(addSize, "adding another");
    finish();
    await saving;
    expect(library.isDirty("axons")).toBe(true);
    expect(printFilter(library.tree("axons")!)).toBe(
      "both axon >= 30% and both size > 20k and both size > 20k",
    );
  });

  it("stays on the filter the user moved to while a delete was on its way", async () => {
    const client = fakeClient({
      axons: AXONS,
      dendrites: "both dendrite > 80%",
      spines: AXONS,
    });
    let finish: () => void = () => {};
    client.remove = (id) =>
      new Promise((resolve) => {
        finish = () => {
          client.presets.delete(id);
          resolve();
        };
      });
    const library = await loaded(client);
    const removing = library.remove();
    library.select("spines");
    finish();
    await removing;
    expect(library.current).toBe("spines");
  });

  it("reports a library that failed to load", async () => {
    const client = fakeClient();
    client.list = async () => {
      throw new Error("offline");
    };
    const library = new FilterLibrary(client, memoryStore());
    await expect(library.load()).rejects.toThrow("offline");
    expect(library.loadError).toBe("Error: offline");
  });

  it("tells listeners about every change", async () => {
    const library = await loaded();
    let changes = 0;
    library.changed.add(() => changes++);
    library.edit(addSize, "adding a measure");
    library.revert();
    expect(changes).toBe(2);
  });
});
