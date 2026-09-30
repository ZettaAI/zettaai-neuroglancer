import { describe, expect, it } from "vitest";
import {
  normalizeTargets,
  parseFilterText,
  printFilter,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type {
  ConditionNode,
  FilterNode,
  GroupNode,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  addRow,
  checkNumber,
  dropRow,
  duplicateRow,
  findNode,
  moveRow,
  removeRow,
  setChoice,
  setNumber,
  setTarget,
} from "#src/datasource/calcada/filter_tree_edits.js";

const print = (root: GroupNode) => {
  normalizeTargets(root);
  return printFilter(root);
};
const idOf = (root: GroupNode, text: string) => {
  let found: FilterNode | undefined;
  const walk = (node: FilterNode) => {
    if (printFilter({ kind: "group", op: "all", children: [node] }) === text) {
      found ??= node;
    }
    if (node.kind === "group") node.children.forEach(walk);
    if (node.kind === "neighbors") walk(node.where);
  };
  root.children.forEach(walk);
  return found!.id!;
};

describe("checkNumber", () => {
  const size: ConditionNode = {
    kind: "cond",
    field: "size",
    op: ">",
    value: 1,
  };
  const axon: ConditionNode = {
    kind: "cond",
    field: "axon",
    op: ">",
    value: 1,
  };
  it("reads sizes with k and M and percentages without them", () => {
    expect(checkNumber(size, "value", "20k")).toEqual({ value: 20000 });
    expect(checkNumber(size, "value", "1.5M")).toEqual({ value: 1500000 });
    expect(checkNumber(axon, "value", "30")).toEqual({ value: 30 });
    expect(checkNumber(axon, "value", "30%")).toEqual({ value: 30 });
  });
  it("explains what is wrong, in the prototype's words", () => {
    expect(checkNumber(size, "value", "abc")).toEqual({
      message: "Enter a size in voxels, like 20k or 20000",
    });
    expect(checkNumber(size, "value", "1.5m")).toEqual({
      message: "Use a capital M for million, like 1.5M",
    });
    expect(checkNumber(axon, "value", "120")).toEqual({
      message: "A percentage must be 0 to 100",
    });
    expect(checkNumber(axon, "value", "3k")).toEqual({
      message: "A percentage takes no k or M",
    });
    expect(
      checkNumber(
        {
          kind: "neighbors",
          quant: "no",
          count: 0,
          hops: 1,
          where: { kind: "group", op: "all", children: [] },
        },
        "hops",
        "0",
      ),
    ).toEqual({ message: "Hops must be at least 1" });
    expect(
      checkNumber(
        { ...size, op: "between", value: 10, value2: 20 },
        "value",
        "30",
      ),
    ).toEqual({
      message:
        "30 to 20 is backwards. Raise the upper end first, or swap the numbers.",
    });
  });
});

describe("tree edits", () => {
  it("adds a row with the prototype's defaults", () => {
    const root = parseFilterText("both axon >= 30%");
    const added = addRow(root, root.id!, "cond");
    expect(print(root)).toBe("both axon >= 30% and both size > 20k");
    expect(findNode(root, added.id!)?.node).toBe(added);
    addRow(root, root.id!, "bond");
    expect(print(root)).toContain(
      "both in a part <= 40k attached by <= 2 edges",
    );
  });

  it("removes a row and prunes the groups it leaves empty", () => {
    const root = parseFilterText("both axon >= 30% and seed((size > 1k))");
    removeRow(root, idOf(root, "size > 1k"));
    expect(print(root)).toBe("both axon >= 30%");
  });

  it("duplicates a row with fresh ids", () => {
    const root = parseFilterText("both axon >= 30%");
    const id = root.children[0].id!;
    duplicateRow(root, id);
    expect(print(root)).toBe("both axon >= 30% and both axon >= 30%");
    expect(root.children[1].id).not.toBe(id);
  });

  it("moves a row within its group and says when it cannot", () => {
    const root = parseFilterText("both axon >= 30% and both size > 1k");
    expect(moveRow(root, root.children[0].id!, 1)).toBe("moved");
    expect(print(root)).toBe("both size > 1k and both axon >= 30%");
    expect(moveRow(root, root.children[1].id!, 1)).toBe("last");
    expect(moveRow(root, root.children[0].id!, -1)).toBe("first");
  });

  it("drops a row into another group, keeping whose piece it was about", () => {
    const root = parseFilterText(
      "seed size > 1k and candidate(axon > 10% or dendrite > 10%)",
    );
    const moved = idOf(root, "seed size > 1k");
    const into = root.children[1].id!;
    expect(dropRow(root, moved, into, undefined)).toBe(true);
    expect(print(root)).toBe(
      "candidate(axon > 10% or dendrite > 10% or size > 1k)",
    );
  });

  it("refuses to drop a group into itself", () => {
    const root = parseFilterText("both(size > 1k or axon > 10%)");
    const group = root.children[0].id!;
    expect(dropRow(root, group, group, undefined)).toBe(false);
  });

  it("gives a group's rows its target, and back to each row", () => {
    const root = parseFilterText("seed size > 1k and candidate axon > 10%");
    const wrapped = parseFilterText("(seed size > 1k or candidate axon > 10%)");
    const group = wrapped.children[0] as GroupNode;
    expect(setTarget(wrapped, group.id!, "both")).toEqual({ replaced: true });
    expect(print(wrapped)).toBe("both(size > 1k or axon > 10%)");
    setTarget(wrapped, group.id!, undefined);
    expect(print(wrapped)).toBe("both size > 1k or both axon > 10%");
    expect(setTarget(root, root.children[0].id!, "both")).toEqual({
      replaced: false,
    });
  });

  it("keeps values sensible when the measure or comparison changes", () => {
    const root = parseFilterText("both size > 200k");
    const id = root.children[0].id!;
    setChoice(root, id, "field", "axon");
    expect(print(root)).toBe("both axon > 50%");
    setChoice(root, id, "op", "between");
    expect(print(root)).toBe("both axon from 50% to 70%");
    setChoice(root, id, "field", "size");
    expect(print(root)).toBe("both size from 20k to 60k");
  });

  it("sets a number", () => {
    const root = parseFilterText("both size > 200k");
    setNumber(root, root.children[0].id!, "value", 5000);
    expect(print(root)).toBe("both size > 5k");
  });
});
