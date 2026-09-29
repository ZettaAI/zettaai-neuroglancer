import { describe, expect, it } from "vitest";
import type {
  FilterGroup,
  FilterSubject,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  addChild,
  defaultCondition,
  emptyFilterTree,
  filterTreesEqual,
  legacyFilterTree,
  minCandidateVoxels,
  parseFilterTree,
  removeNode,
  semanticsKnown,
  serializeFilterTree,
  subjectPasses,
  toggleGroupOp,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import type { PieceClasses } from "#src/datasource/calcada/candidate_heat.js";

const none: PieceClasses = {
  perikaryon: 0,
  dendrite: 0,
  axon: 0,
  glia: 0,
  vasculature: 0,
  nucleus: 0,
  ecs: 0,
  other: 0,
};
const axon: PieceClasses = { ...none, axon: 9, dendrite: 1 };
const dendrite: PieceClasses = { ...none, dendrite: 9, axon: 1 };

function subject(overrides: Partial<FilterSubject> = {}): FilterSubject {
  return {
    score: 0.9,
    seed: { voxels: 1000, classes: axon, hasInfo: true },
    candidate: { voxels: 6000, classes: axon, hasInfo: true },
    ...overrides,
  };
}
const known = { seed: true, candidate: true };

const share = (
  side: "seed" | "candidate",
  cls: "axon" | "dendrite",
  value: number,
) => ({
  kind: "condition" as const,
  field: { side, measure: "share" as const, class: cls },
  cmp: ">=" as const,
  value,
});
const size = (side: "seed" | "candidate", cmp: ">=" | "<=", value: number) => ({
  kind: "condition" as const,
  field: { side, measure: "voxels" as const },
  cmp,
  value,
});
const and = (...children: FilterGroup["children"]): FilterGroup => ({
  kind: "group",
  op: "and",
  children,
});
const or = (...children: FilterGroup["children"]): FilterGroup => ({
  kind: "group",
  op: "or",
  children,
});

// (seed axon ≥ .8 AND cand axon ≥ .8) OR (cand dendrite ≥ .8 AND cand ≥ 5000)
const example = or(
  and(share("seed", "axon", 0.8), share("candidate", "axon", 0.8)),
  and(share("candidate", "dendrite", 0.8), size("candidate", ">=", 5000)),
);

describe("subjectPasses", () => {
  it("passes everything with an empty tree", () => {
    expect(subjectPasses(subject(), emptyFilterTree(), known)).toBe(true);
  });

  it("evaluates AND and OR through nesting", () => {
    expect(subjectPasses(subject(), example, known)).toBe(true);
    const dendriteBig = subject({
      seed: { voxels: 1, classes: dendrite, hasInfo: true },
      candidate: { voxels: 6000, classes: dendrite, hasInfo: true },
    });
    expect(subjectPasses(dendriteBig, example, known)).toBe(true);
    const dendriteSmall = subject({
      seed: { voxels: 1, classes: dendrite, hasInfo: true },
      candidate: { voxels: 10, classes: dendrite, hasInfo: true },
    });
    expect(subjectPasses(dendriteSmall, example, known)).toBe(false);
  });

  it("honours <=", () => {
    expect(
      subjectPasses(subject(), and(size("candidate", "<=", 5000)), known),
    ).toBe(false);
    expect(
      subjectPasses(subject(), and(size("candidate", "<=", 6000)), known),
    ).toBe(true);
  });

  it("does not filter by class on a side nobody has semantics for", () => {
    const blind = subject({
      candidate: { voxels: 6000, classes: none, hasInfo: false },
    });
    const tree = and(share("candidate", "dendrite", 0.8));
    expect(subjectPasses(blind, tree, semanticsKnown([blind]))).toBe(true);
    expect(subjectPasses(blind, tree, known)).toBe(false);
  });
});

describe("minCandidateVoxels", () => {
  it("takes the max under AND and the min under OR", () => {
    expect(minCandidateVoxels(example)).toBe(0);
    expect(
      minCandidateVoxels(
        and(
          size("candidate", ">=", 100),
          or(size("candidate", ">=", 500), size("candidate", ">=", 300)),
        ),
      ),
    ).toBe(300);
  });

  it("pushes nothing for <= or for the seed side", () => {
    expect(minCandidateVoxels(and(size("candidate", "<=", 500)))).toBe(0);
    expect(minCandidateVoxels(and(size("seed", ">=", 500)))).toBe(0);
    expect(minCandidateVoxels(emptyFilterTree())).toBe(0);
  });
});

describe("parseFilterTree", () => {
  it("round-trips a serialized tree", () => {
    const parsed = parseFilterTree(
      JSON.parse(JSON.stringify(serializeFilterTree(example))),
    );
    expect(parsed).toEqual(example);
  });

  it("rejects other versions and malformed nodes", () => {
    expect(parseFilterTree({ v: 2, root: example })).toBeUndefined();
    expect(
      parseFilterTree({ v: 1, root: { kind: "condition" } }),
    ).toBeUndefined();
    expect(
      parseFilterTree({
        v: 1,
        root: and({
          kind: "condition",
          field: { measure: "height" },
          cmp: ">=",
          value: 1,
        } as never),
      }),
    ).toBeUndefined();
    expect(
      parseFilterTree({
        v: 1,
        root: and({ ...size("seed", ">=", 1), cmp: "!=" } as never),
      }),
    ).toBeUndefined();
    expect(parseFilterTree("garbage")).toBeUndefined();
  });
});

describe("legacyFilterTree", () => {
  it("rebuilds the old fixed form as one AND", () => {
    const tree = legacyFilterTree({
      minScore: 0.5,
      seedMinVoxels: 0,
      candidateMinVoxels: 2000,
      seedClass: "axon",
      seedMinFraction: 0.8,
      candidateClass: "any",
      candidateMinFraction: 0.8,
    });
    expect(tree.op).toBe("and");
    expect(tree.children).toHaveLength(3);
    expect(minCandidateVoxels(tree)).toBe(2000);
  });

  it("is empty for the old defaults", () => {
    const tree = legacyFilterTree({
      minScore: 0,
      seedMinVoxels: 0,
      candidateMinVoxels: 0,
      seedClass: "any",
      seedMinFraction: 0.8,
      candidateClass: "any",
      candidateMinFraction: 0.8,
    });
    expect(filterTreesEqual(tree, emptyFilterTree())).toBe(true);
  });
});

describe("edits", () => {
  it("adds into the group the path names", () => {
    const tree = addChild(example, [1], defaultCondition());
    expect((tree.children[1] as FilterGroup).children).toHaveLength(3);
    expect((example.children[1] as FilterGroup).children).toHaveLength(2);
  });

  it("toggles a whole group's operator", () => {
    expect(toggleGroupOp(example, []).op).toBe("and");
    expect((toggleGroupOp(example, [0]).children[0] as FilterGroup).op).toBe(
      "or",
    );
  });

  it("removes a node, leaving an empty group renderable", () => {
    let tree = removeNode(example, [1, 0]);
    tree = removeNode(tree, [1, 0]);
    expect((tree.children[1] as FilterGroup).children).toEqual([]);
    expect(subjectPasses(subject(), tree, known)).toBe(true);
  });
});
