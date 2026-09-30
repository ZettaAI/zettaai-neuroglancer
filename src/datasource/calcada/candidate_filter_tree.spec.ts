import { describe, expect, it } from "vitest";
import {
  parseFilterText,
  sameFilter,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type {
  FilterNode,
  FilterSubject,
  GraphFacts,
  GroupNode,
  ConditionField,
  ConditionNode,
  NeighborsNode,
  PieceFacts,
  Target,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  emptyFilterTree,
  minCandidateVoxels,
  NO_GRAPH,
  subjectVerdict,
  parseFilterDocument,
  semanticsKnown,
  serializeFilterTree,
  subjectPasses,
  validationError,
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
const axonHeavy: PieceClasses = { ...none, axon: 9, dendrite: 1 };
const dendriteHeavy: PieceClasses = { ...none, dendrite: 9, axon: 1 };
const known = { seed: true, candidate: true };

function piece(
  pieceId: bigint,
  voxels: number,
  classes: PieceClasses = axonHeavy,
): PieceFacts {
  return { pieceId, voxels, classes, hasInfo: true };
}

function subject(seed: PieceFacts, candidate: PieceFacts, score = 0.9) {
  return { score, seed, candidate } satisfies FilterSubject;
}

const group = (
  op: GroupNode["op"],
  children: FilterNode[],
  target?: Target,
): GroupNode => ({ kind: "group", op, children, ...(target && { target }) });

const measure = (
  field: ConditionField,
  op: ConditionNode["op"],
  value: number,
  value2?: number,
  target?: Target,
): ConditionNode => ({
  kind: "cond",
  field,
  op,
  value,
  ...(value2 !== undefined && { value2 }),
  ...(target && { target }),
});

const neighbours = (
  quant: NeighborsNode["quant"],
  count: number,
  hops: number,
  where: GroupNode,
  target?: Target,
): NeighborsNode => ({
  kind: "neighbors",
  quant,
  count,
  hops,
  where,
  ...(target && { target }),
});

/** A fake graph: each piece's neighbours by hop count. */
function graph(
  byPiece: Record<string, PieceFacts[]>,
  parts: Record<string, { edges: number; voxels: number }> = {},
): GraphFacts {
  return {
    neighbours: (p) => byPiece[String(p)],
    part: (p) => parts[String(p)],
  };
}

const small = piece(1n, 10_000);
const big = piece(2n, 100_000);

describe("groups", () => {
  it("combines children with ALL, ANY and NONE; an empty group passes", () => {
    const s = subject(small, big);
    const yes = measure("size", "<", 20_000, undefined, "seed");
    const no = measure("size", "<", 20_000, undefined, "candidate");
    expect(subjectPasses(s, group("all", [yes, no]), known, NO_GRAPH)).toBe(
      false,
    );
    expect(subjectPasses(s, group("any", [yes, no]), known, NO_GRAPH)).toBe(
      true,
    );
    expect(subjectPasses(s, group("none", [no]), known, NO_GRAPH)).toBe(true);
    expect(subjectPasses(s, emptyFilterTree(), known, NO_GRAPH)).toBe(true);
  });

  it("includes both ends of a range", () => {
    const s = subject(piece(1n, 20_000), piece(2n, 60_000));
    const range = measure("size", "between", 20_000, 60_000, "both");
    expect(subjectPasses(s, group("all", [range]), known, NO_GRAPH)).toBe(true);
  });
});

describe("targets", () => {
  // Option 1 fits a small piece, option 2 a big one.
  const options = [measure("size", "<", 20_000), measure("size", ">", 60_000)];

  it("lets the seed and candidate pass different options under a Both group", () => {
    const tree = group("all", [group("any", options, "both")]);
    expect(subjectPasses(subject(small, big), tree, known, NO_GRAPH)).toBe(
      true,
    );
  });

  it("makes them pass the same option when each row picks Both", () => {
    const tree = group("all", [
      group(
        "any",
        options.map((o) => ({ ...o, target: "both" as const })),
      ),
    ]);
    expect(subjectPasses(subject(small, big), tree, known, NO_GRAPH)).toBe(
      false,
    );
    expect(subjectPasses(subject(small, small), tree, known, NO_GRAPH)).toBe(
      true,
    );
  });

  it("judges score on the match, without a target", () => {
    const tree = group("all", [measure("score", ">=", 0.5)]);
    expect(subjectPasses(subject(small, big, 0.4), tree, known, NO_GRAPH)).toBe(
      false,
    );
    expect(subjectPasses(subject(small, big, 0.6), tree, known, NO_GRAPH)).toBe(
      true,
    );
  });

  it("rejects a piece condition nobody said whose piece it is about", () => {
    const tree = group("all", [measure("size", "<", 20_000)]);
    expect(validationError(tree)).toBeDefined();
    expect(subjectPasses(subject(small, small), tree, known, NO_GRAPH)).toBe(
      false,
    );
    expect(
      validationError(group("all", [measure("score", ">=", 0)])),
    ).toBeUndefined();
  });

  it("does not filter by class on a side nobody has semantics for", () => {
    const blind = { ...big, hasInfo: false, classes: none };
    const tree = group("all", [
      measure("dendrite", ">", 80, undefined, "candidate"),
    ]);
    const s = subject(small, blind);
    expect(subjectPasses(s, tree, semanticsKnown([s]), NO_GRAPH)).toBe(true);
    expect(subjectPasses(s, tree, known, NO_GRAPH)).toBe(false);
  });
});

describe("neighbours", () => {
  const bigDendrite = group("all", [
    measure("size", ">", 200_000),
    measure("dendrite", ">", 80),
  ]);
  const shaft = piece(9n, 500_000, dendriteHeavy);
  const twig = piece(8n, 5_000, axonHeavy);
  const g = graph({ "1": [shaft, twig], "2": [twig] });
  const s = subject(small, big);

  it("counts neighbours passing the inner group", () => {
    const at = (quant: NeighborsNode["quant"], count: number) =>
      group("all", [neighbours(quant, count, 3, bigDendrite, "seed")]);
    expect(subjectPasses(s, at("no", 0), known, g)).toBe(false);
    expect(subjectPasses(s, at("at_least", 1), known, g)).toBe(true);
    expect(subjectPasses(s, at("at_most", 0), known, g)).toBe(false);
    expect(subjectPasses(s, at("exactly", 1), known, g)).toBe(true);
  });

  it("counts every neighbour when the inner group is empty", () => {
    const tree = group("all", [
      neighbours("exactly", 2, 1, emptyFilterTree(), "seed"),
    ]);
    expect(subjectPasses(s, tree, known, g)).toBe(true);
  });

  it("fails when the graph has not answered for the piece", () => {
    const tree = group("all", [neighbours("no", 0, 3, bigDendrite, "seed")]);
    expect(subjectPasses(s, tree, known, NO_GRAPH)).toBe(false);
  });
});

describe("while the graph has not answered", () => {
  const bond = {
    kind: "bond" as const,
    maxSize: 5_000,
    edges: 2,
    target: "candidate" as const,
  };
  const isSmall = measure("size", "<", 50_000, undefined, "seed");
  const isHuge = measure("size", ">", 1_000_000, undefined, "seed");
  const s = subject(small, big);

  it("is unknown rather than failed", () => {
    expect(subjectVerdict(s, group("all", [bond]), known, NO_GRAPH)).toBe(
      undefined,
    );
    expect(subjectVerdict(s, group("none", [bond]), known, NO_GRAPH)).toBe(
      undefined,
    );
  });

  it("is decided when the rest of the tree decides it", () => {
    expect(
      subjectVerdict(s, group("any", [isSmall, bond]), known, NO_GRAPH),
    ).toBe(true);
    expect(
      subjectVerdict(s, group("all", [isHuge, bond]), known, NO_GRAPH),
    ).toBe(false);
    expect(
      subjectVerdict(s, group("none", [isSmall, bond]), known, NO_GRAPH),
    ).toBe(false);
  });

  it("never passes through subjectPasses", () => {
    expect(subjectPasses(s, group("none", [bond]), known, NO_GRAPH)).toBe(
      false,
    );
  });

  it("fails a piece the graph answered for without a part", () => {
    const answered: GraphFacts = { neighbours: () => [], part: () => null };
    expect(subjectVerdict(s, group("all", [bond]), known, answered)).toBe(
      false,
    );
  });
});

describe("bond", () => {
  const tree = group("all", [
    { kind: "bond", maxSize: 40_000, edges: 2, target: "candidate" },
  ]);
  it("passes a part that fits the budget and the edge count", () => {
    const g = graph({}, { "2": { edges: 2, voxels: 30_000 } });
    expect(subjectPasses(subject(small, big), tree, known, g)).toBe(true);
  });
  it("fails a part too large or attached by too many edges", () => {
    expect(
      subjectPasses(
        subject(small, big),
        tree,
        known,
        graph({}, { "2": { edges: 2, voxels: 50_000 } }),
      ),
    ).toBe(false);
    expect(
      subjectPasses(
        subject(small, big),
        tree,
        known,
        graph({}, { "2": { edges: 3, voxels: 1_000 } }),
      ),
    ).toBe(false);
    expect(subjectPasses(subject(small, big), tree, known, NO_GRAPH)).toBe(
      false,
    );
  });
});

describe("Sergiy's filters", () => {
  const bigDendrite = group("all", [
    measure("size", ">", 200_000),
    measure("dendrite", ">", 80),
  ]);
  const axonContinuation = group("all", [
    group(
      "any",
      [
        group("all", [
          measure("size", "<", 20_000),
          neighbours("no", 0, 3, bigDendrite),
        ]),
        group("all", [
          measure("size", "between", 20_000, 60_000),
          measure("axon", ">=", 10),
          neighbours("no", 0, 2, bigDendrite),
        ]),
        group("all", [measure("size", ">", 60_000), measure("axon", ">=", 30)]),
      ],
      "both",
    ),
  ]);
  const dendriteContinuation = group("all", [
    group(
      "all",
      [measure("size", ">", 200_000), measure("dendrite", ">", 80)],
      "both",
    ),
  ]);
  const shaft = piece(9n, 500_000, dendriteHeavy);

  it("axon continuation skips a small piece next to a big dendrite", () => {
    const spineish = piece(3n, 5_000);
    const s = subject(piece(4n, 100_000), spineish);
    expect(validationError(axonContinuation)).toBeUndefined();
    expect(
      subjectPasses(
        s,
        axonContinuation,
        known,
        graph({ "3": [shaft], "4": [] }),
      ),
    ).toBe(false);
    expect(
      subjectPasses(s, axonContinuation, known, graph({ "3": [], "4": [] })),
    ).toBe(true);
  });

  it("dendrite continuation needs both ends big and dendritic", () => {
    const d1 = piece(5n, 300_000, dendriteHeavy);
    const d2 = piece(6n, 250_000, dendriteHeavy);
    expect(
      subjectPasses(subject(d1, d2), dendriteContinuation, known, NO_GRAPH),
    ).toBe(true);
    expect(
      subjectPasses(
        subject(d1, piece(7n, 250_000)),
        dendriteContinuation,
        known,
        NO_GRAPH,
      ),
    ).toBe(false);
  });

  it("reads the doc's stored dendrite continuation as is", () => {
    const stored = {
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
    };
    const parsed = parseFilterDocument(stored)!;
    expect(sameFilter(parsed, dendriteContinuation)).toBe(true);
    expect(serializeFilterTree(parsed).root).toEqual(stored);
  });
});

describe("the doc's meaning", () => {
  const big = piece(2n, 300_000, dendriteHeavy);
  const s = subject(piece(1n, 10_000), big);

  it("lets the outermost target decide, as eval_on ignores inner ones", () => {
    const tree = group("all", [
      group(
        "all",
        [measure("size", ">", 100_000, undefined, "seed")],
        "candidate",
      ),
    ]);
    expect(validationError(tree)).toBeUndefined();
    expect(subjectPasses(s, tree, known, NO_GRAPH)).toBe(true);
  });

  it("counts neighbours of neighbours", () => {
    const hub = piece(7n, 5_000);
    const g = graph({ "2": [hub], "7": [big, piece(8n, 1)] });
    const tree = group("all", [
      neighbours(
        "at_least",
        1,
        1,
        group("all", [neighbours("exactly", 2, 1, emptyFilterTree())]),
        "candidate",
      ),
    ]);
    expect(subjectPasses(s, tree, known, g)).toBe(true);
  });

  it("asks a neighbour for its bond", () => {
    const spine = piece(7n, 500);
    const tree = group("all", [
      neighbours(
        "no",
        0,
        1,
        group("all", [{ kind: "bond", maxSize: 1_000, edges: 2 }]),
        "candidate",
      ),
    ]);
    const withParts = (edges: number): GraphFacts => ({
      neighbours: (p) => (p === 2n ? [spine] : undefined),
      part: (p) => (p === 7n ? { edges, voxels: 500 } : undefined),
    });
    expect(subjectPasses(s, tree, known, withParts(2))).toBe(false);
    expect(subjectPasses(s, tree, known, withParts(3))).toBe(true);
  });

  it("decides a count before every neighbour is known when it can", () => {
    const tree = group("all", [
      neighbours(
        "no",
        0,
        1,
        group("all", [{ kind: "bond", maxSize: 1_000, edges: 2 }]),
        "candidate",
      ),
    ]);
    const partial: GraphFacts = {
      neighbours: () => [piece(7n, 1), piece(8n, 1)],
      part: (p) => (p === 7n ? { edges: 1, voxels: 1 } : undefined),
    };
    expect(subjectVerdict(s, tree, known, partial)).toBe(false);
  });
});

describe("minCandidateVoxels", () => {
  it("follows ALL, ANY, NONE and inherited targets", () => {
    const floor = (tree: GroupNode) => minCandidateVoxels(tree);
    const atLeast = (v: number, target?: Target) =>
      measure("size", ">=", v, undefined, target);
    expect(
      floor(group("all", [atLeast(500, "candidate"), atLeast(900, "seed")])),
    ).toBe(500);
    expect(
      floor(group("all", [group("any", [atLeast(500), atLeast(300)], "both")])),
    ).toBe(300);
    expect(floor(group("all", [group("none", [atLeast(500)], "both")]))).toBe(
      0,
    );
    expect(
      floor(
        group("all", [measure("size", "between", 20_000, 60_000, "candidate")]),
      ),
    ).toBe(20_000);
    expect(
      floor(group("all", [measure("size", "<", 500, undefined, "candidate")])),
    ).toBe(0);
  });
});

describe("documents", () => {
  const tree = group("all", [
    group("any", [measure("axon", ">=", 30)], "both"),
    { kind: "bond", maxSize: 40_000, edges: 2, target: "seed" },
    neighbours("at_least", 2, 1, emptyFilterTree(), "candidate"),
  ]);

  it("round-trips a v2 document, ids included", () => {
    const stored = JSON.parse(JSON.stringify(serializeFilterTree(tree)));
    const parsed = parseFilterDocument(stored)!;
    expect(sameFilter(parsed, tree)).toBe(true);
    expect(serializeFilterTree(parsed)).toEqual(stored);
  });

  it("migrates v1 and refuses anything else", () => {
    expect(
      parseFilterDocument({
        v: 1,
        root: { kind: "group", op: "and", children: [] },
      }),
    ).toMatchObject({ kind: "group", op: "all", children: [] });
    expect(
      parseFilterDocument({ v: 2, root: { kind: "mystery" } }),
    ).toBeUndefined();
    expect(
      parseFilterDocument({ v: 3, root: emptyFilterTree() }),
    ).toBeUndefined();
  });
});

describe("sameFilter", () => {
  it("treats groupings that change nothing as the same filter", () => {
    expect(
      sameFilter(
        parseFilterText("both(size > 1k)"),
        parseFilterText("both((size > 1k))"),
      ),
    ).toBe(true);
  });
});

describe("parseFilterDocument validation", () => {
  it("rejects a v2 tree that cannot be evaluated", () => {
    const sideless = {
      v: 2,
      root: {
        kind: "group",
        op: "all",
        children: [{ kind: "cond", field: "size", op: ">", value: 1 }],
      },
    };
    expect(parseFilterDocument(sideless)).toBeUndefined();
  });
});

describe("migrated filters", () => {
  it("give every node an id, as the editor finds rows by id", () => {
    const tree = parseFilterDocument({
      v: 1,
      root: {
        kind: "group",
        op: "and",
        children: [
          {
            kind: "condition",
            field: { side: "candidate", measure: "voxels" },
            cmp: ">=",
            value: 30000,
          },
        ],
      },
    })!;
    expect(tree.id).toBeDefined();
    expect(tree.children[0].id).toBeDefined();
  });
});
