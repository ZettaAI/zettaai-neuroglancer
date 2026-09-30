import { describe, expect, it } from "vitest";
import {
  FilterParseError,
  noteFor,
  patchNote,
  reconcileIds,
  parseFilterText,
  parseFilterTextWithSpans,
  printFilter,
  sameFilter,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type {
  ConditionNode,
  GroupNode,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import { parseFilterDocument } from "#src/datasource/calcada/candidate_filter_tree.js";

const AXON = `both(
  (size < 20k
   and no neighbors within 3 hops with (size > 200k and dendrite > 80%))
  or (size from 20k to 60k and axon >= 10%
      and no neighbors within 2 hops with (size > 200k and dendrite > 80%))
  or (size > 60k and axon >= 30%)
)`;
// The doc was printed a little narrower than the editor default.
const DOC_WIDTH = 80;
const DENDRITE = "both(size > 200k and dendrite > 80%)";

function errorOf(src: string) {
  try {
    parseFilterText(src);
  } catch (e) {
    if (e instanceof FilterParseError) return e;
    throw e;
  }
  throw new Error("parsed");
}

describe("Sergiy's filters", () => {
  it("print exactly as the hand-off doc writes them", () => {
    expect(printFilter(parseFilterText(AXON), DOC_WIDTH)).toBe(AXON);
    expect(printFilter(parseFilterText(DENDRITE))).toBe(DENDRITE);
  });
  it("parse to the doc's stored dendrite continuation", () => {
    const stored = parseFilterDocument({
      id: "n22",
      kind: "group",
      op: "all",
      target: null,
      children: [
        {
          id: "n21",
          kind: "group",
          op: "all",
          target: "both",
          children: [
            {
              id: "n19",
              kind: "cond",
              field: "size",
              op: ">",
              value: 200000,
              value2: null,
              target: null,
            },
            {
              id: "n20",
              kind: "cond",
              field: "dendrite",
              op: ">",
              value: 80,
              value2: null,
              target: null,
            },
          ],
        },
      ],
    })!;
    expect(sameFilter(parseFilterText(DENDRITE), stored)).toBe(true);
  });
});

describe("targets", () => {
  it("fills Both only for a plain top-level and", () => {
    expect(printFilter(parseFilterText("size > 20k and axon > 10%"))).toBe(
      "both size > 20k and both axon > 10%",
    );
    expect(errorOf("size > 20k or axon > 10%").message).toMatch(
      /^Say whose piece this is about/,
    );
    expect(errorOf("seed size > 1 and axon > 10%").message).toMatch(
      /^Say whose piece/,
    );
  });
  it("refuses a target inside another or inside a neighbor body", () => {
    expect(errorOf("both(seed size > 1)").message).toMatch(
      /already inside both/,
    );
    expect(
      errorOf("both no neighbors within 1 hop with (seed size > 1)").message,
    ).toMatch(/can’t be used inside a neighbor condition/);
  });
  it("lets score stand without a target", () => {
    expect(
      printFilter(parseFilterText("score >= 0.5 and both size > 1k")),
    ).toBe("score >= 0.5 and both size > 1k");
  });
});

describe("errors point at the word", () => {
  it.each([
    ["both size > 20%", "20%", /^Size is in voxels/, 0],
    ["both axon > 10", "10", /^Write 10% — axon is a percentage/, 1],
    ["both size = 3", "=", /^There is no =/, 1],
    ["both sise > 3", "sise", /Did you mean “size”\?/, 1],
    ["both size from 60k to 20k", "60k to 20k", /is backwards/, 1],
    ["both(size > 1", "(", /never closed/, 1],
  ])("%s", (src, _word, message, _i) => {
    const error = errorOf(src);
    expect(error.message).toMatch(message);
    expect(error.end).toBeGreaterThan(error.start);
  });
});

describe("round trip", () => {
  // Port of the kit's test_lang.js: random trees printed, parsed back, compared.
  function random(seed: number) {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  }
  const FIELDS = ["size", "axon", "dendrite", "perikaryon", "nucleus"] as const;
  function tree(
    r: () => number,
    depth: number,
    inBody: boolean,
  ): GroupNode["children"][number] {
    const k = r();
    if (depth > 2 || k < 0.45) {
      const field = FIELDS[Math.floor(r() * FIELDS.length)];
      const pct = field !== "size";
      const value = pct ? Math.floor(r() * 100) : Math.floor(r() * 500) * 1000;
      return r() < 0.2
        ? {
            kind: "cond",
            field,
            op: "between",
            value,
            value2: value + (pct ? 0 : 1000),
          }
        : {
            kind: "cond",
            field,
            op: (["<", "<=", ">", ">="] as const)[Math.floor(r() * 4)],
            value,
          };
    }
    if (k < 0.6)
      return {
        kind: "bond",
        maxSize: Math.floor(r() * 100) * 1000,
        edges: Math.floor(r() * 4),
      };
    if (k < 0.75 && !inBody)
      return {
        kind: "neighbors",
        quant: (["no", "at_least", "at_most", "exactly"] as const)[
          Math.floor(r() * 4)
        ],
        count: Math.floor(r() * 3),
        hops: 1 + Math.floor(r() * 3),
        where: {
          kind: "group",
          op: "all",
          children: [tree(r, depth + 1, true)],
        },
      };
    return {
      kind: "group",
      op: (["all", "any", "none"] as const)[Math.floor(r() * 3)],
      children: [tree(r, depth + 1, inBody), tree(r, depth + 1, inBody)],
    };
  }
  it("prints and parses 5,000 random filters back to the same filter", () => {
    const r = random(7);
    for (let i = 0; i < 5000; i++) {
      const root: GroupNode = {
        kind: "group",
        op: "all",
        children: [
          {
            kind: "group",
            op: "all",
            target: (["seed", "candidate", "both"] as const)[i % 3],
            children: [tree(r, 0, false)],
          },
        ],
      };
      const text = printFilter(root, 40 + (i % 60));
      expect(sameFilter(parseFilterText(text), root), text).toBe(true);
    }
  });
});

describe("spans", () => {
  it("locate each number in the user's own text", () => {
    const src = "both size > 20k  # small\n";
    const { root, spans } = parseFilterTextWithSpans(src);
    const cond =
      (root.children[0] as GroupNode).children?.[0] ?? root.children[0];
    const span = spans.get(cond)!.value!;
    expect(src.slice(span[0], span[1])).toBe("20k");
  });
});

describe("the user's own text", () => {
  it("keeps the ids of rows that did not change when the text is parsed again", () => {
    const before = parseFilterText("both axon >= 30% and both size > 1k");
    const after = parseFilterText("both axon >= 30% and both size > 2k");
    reconcileIds(before, after);
    expect(after.children[0].id).toBe(before.children[0].id);
    expect(after.children[1].id).toBe(before.children[1].id);
  });

  it("is the note only while it still says what the tree says", () => {
    const tree = parseFilterText("both size > 20k");
    tree.note = "both size > 20k  # small pieces";
    expect(noteFor(tree)).toBe(tree.note);
    tree.note = "both size > 30k  # small pieces";
    expect(noteFor(tree)).toBeUndefined();
  });

  it("takes a number changed in the tree into the commented text", () => {
    const note = "both size > 20k  # small pieces\n";
    const before = parseFilterText(note);
    before.note = note;
    const after = structuredClone(before);
    (after.children[0] as ConditionNode).value = 5000;
    expect(patchNote(note, before, after, after.children[0].id!, "value")).toBe(
      "both size > 5k  # small pieces\n",
    );
  });

  it("gives up on a change it cannot write into the text", () => {
    const note = "both size > 20k  # small pieces\n";
    const before = parseFilterText(note);
    const after = parseFilterText("both size > 20k and both axon > 1%");
    expect(patchNote(note, before, after, "nothing", "value")).toBeUndefined();
  });
});
