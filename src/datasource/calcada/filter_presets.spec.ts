import { describe, expect, it } from "vitest";
import { parseFilterPresets } from "#src/datasource/calcada/filter_presets.js";

const tree = { v: 1, root: { kind: "group", op: "and", children: [] } };

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
        tree: tree.root,
        updatedAt: "2026-09-29T10:00:00Z",
      },
    ]);
  });

  it("keeps a preset it cannot read, marked unusable", () => {
    const [preset] = parseFilterPresets([
      { id: "4", name: "future", filter: { v: 2, root: {} }, updated_at: "x" },
    ]);
    expect(preset.name).toBe("future");
    expect(preset.tree).toBeUndefined();
  });

  it("drops entries without an id or name, and a non-array body", () => {
    expect(parseFilterPresets([{ name: "a", filter: tree }])).toEqual([]);
    expect(parseFilterPresets({ presets: [] })).toEqual([]);
  });
});
