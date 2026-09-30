import { describe, expect, it } from "vitest";
import { parseFilterPresets } from "#src/datasource/calcada/filter_presets.js";

const tree = {
  v: 2,
  root: { id: "n1", kind: "group", op: "all", target: null, children: [] },
};

describe("parseFilterPresets", () => {
  it("parses the server's list", () => {
    const presets = parseFilterPresets([
      {
        id: "3",
        name: "axons",
        filter: tree,
        updated_at: "2026-09-29T10:00:00Z",
      },
    ]);
    expect(presets).toEqual([
      {
        id: "3",
        name: "axons",
        tree: { id: "n1", kind: "group", op: "all", children: [] },
        updatedAt: "2026-09-29T10:00:00Z",
      },
    ]);
  });

  it("keeps a preset it cannot read, marked unusable", () => {
    const [preset] = parseFilterPresets([
      { id: "4", name: "future", filter: { v: 3, root: {} }, updated_at: "x" },
    ]);
    expect(preset.name).toBe("future");
    expect(preset.tree).toBeUndefined();
  });

  it("reads a v1 preset as its v2 tree", () => {
    const [preset] = parseFilterPresets([
      {
        id: "5",
        name: "old",
        filter: { v: 1, root: { kind: "group", op: "or", children: [] } },
        updated_at: "x",
      },
    ]);
    expect(preset.tree).toMatchObject({
      kind: "group",
      op: "any",
      children: [],
    });
  });

  it("drops entries without an id or name, and a non-array body", () => {
    expect(parseFilterPresets([{ name: "a", filter: tree }])).toEqual([]);
    expect(parseFilterPresets({ presets: [] })).toEqual([]);
  });
});
