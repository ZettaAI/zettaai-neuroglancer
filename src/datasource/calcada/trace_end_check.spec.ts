import { describe, expect, it } from "vitest";
import type {
  ConditionNode,
  FilterNode,
  GroupNode,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  NO_GRAPH,
  subjectVerdict,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import type { PieceClasses } from "#src/datasource/calcada/candidate_heat.js";
import { edgeCandidateSubject } from "#src/datasource/calcada/candidate_heat.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import {
  checkOutcome,
  endCheckVerdict,
  endPointOf,
  lowerEndThreshold,
  raiseEndThreshold,
  scoreFloor,
  withoutScoreConditions,
} from "#src/datasource/calcada/trace_end_check.js";
import { FULL_SCORE_RANGE } from "#src/datasource/calcada/trace_state.js";

const noClasses: PieceClasses = {
  perikaryon: 0,
  dendrite: 0,
  axon: 0,
  glia: 0,
  vasculature: 0,
  nucleus: 0,
  ecs: 0,
  other: 0,
};
const NOTHING_KNOWN = { seed: false, candidate: false };

function candidate(overrides: Partial<EdgeCandidate> = {}): EdgeCandidate {
  return {
    lineId: 1n,
    score: 0.5,
    selfPieceId: 1n,
    partnerPieceId: 2n,
    partnerRootId: 2n,
    pointA: new Float32Array([1, 2, 3]),
    pointB: new Float32Array([4, 5, 6]),
    nInterfaces: 1,
    modelDecision: "",
    label: "",
    partnerVoxels: 500,
    partnerClasses: noClasses,
    partnerHasInfo: false,
    selfVoxels: 500,
    selfClasses: noClasses,
    selfHasInfo: false,
    ...overrides,
  };
}

const group = (
  children: FilterNode[],
  op: GroupNode["op"] = "all",
): GroupNode => ({
  kind: "group",
  op,
  children,
});
const score = (op: ConditionNode["op"], value: number): ConditionNode => ({
  kind: "cond",
  field: "score",
  op,
  value,
});
const size = (value: number): ConditionNode => ({
  kind: "cond",
  field: "size",
  op: ">=",
  value,
  target: "candidate",
});

const verdictOf = (tree: GroupNode, c: EdgeCandidate) =>
  subjectVerdict(edgeCandidateSubject(c), tree, NOTHING_KNOWN, NO_GRAPH);

describe("trace end check", () => {
  it("accept ends at point B and reject at point A", () => {
    const c = candidate();
    expect(endPointOf("accept", c)).toBe(c.pointB);
    expect(endPointOf("reject", c)).toBe(c.pointA);
  });

  it("withoutScoreConditions removes score conditions and keeps the rest", () => {
    const tree = group([score(">=", 0.3), group([size(100)])]);
    const original = JSON.stringify(tree);
    const stripped = withoutScoreConditions(tree);
    expect(JSON.stringify(tree)).toBe(original);
    const passing = candidate({ score: 0, partnerVoxels: 200 });
    expect(verdictOf(tree, passing)).toBe(false);
    expect(verdictOf(stripped, passing)).toBe(true);
    expect(verdictOf(stripped, candidate({ partnerVoxels: 50 }))).toBe(false);
    expect(stripped.children[1]).toEqual(tree.children[1]);
  });

  it("withoutScoreConditions leaves neighbour conditions unchanged", () => {
    const where = group([score(">=", 0.9), size(100)]);
    const neighbors: FilterNode = {
      kind: "neighbors",
      quant: "no",
      count: 0,
      hops: 1,
      where,
    };
    const tree = group([neighbors]);
    expect(withoutScoreConditions(tree).children[0]).toEqual(neighbors);
  });

  it("withoutScoreConditions keeps score conditions under any and none", () => {
    const anyGroup = group([score(">=", 0.5), size(100)], "any");
    const noneGroup = group([score(">=", 0.3)], "none");
    const tree = group([anyGroup, noneGroup, group([score(">=", 0.2)])]);
    expect(withoutScoreConditions(tree).children).toEqual([
      anyGroup,
      noneGroup,
      group([{ kind: "group", op: "all", children: [] }]),
    ]);
    expect(withoutScoreConditions(group([score(">=", 0.5)], "any"))).toEqual(
      group([score(">=", 0.5)], "any"),
    );
  });

  it("scoreFloor is the largest lower bound a score condition sets", () => {
    const tree = group([score(">=", 0.3), size(100), score("<", 0.9)]);
    expect(scoreFloor(tree, FULL_SCORE_RANGE)).toBe(0.3);
    expect(scoreFloor(tree, [0.4, 1])).toBe(0.4);
    expect(scoreFloor(group([]), FULL_SCORE_RANGE)).toBe(0);
    expect(scoreFloor(group([score("between", 0.5)]), [0.1, 1])).toBe(0.5);
    expect(scoreFloor(group([group([score(">=", 0.6)])]), [0.1, 1])).toBe(0.6);
  });

  it("scoreFloor counts only bounds reached through all groups", () => {
    const range: [number, number] = [0.1, 1];
    const anyTree = group([
      group([score(">=", 0.5), group([score(">=", 0.3), size(100)])], "any"),
    ]);
    expect(scoreFloor(anyTree, range)).toBe(0.1);
    expect(scoreFloor(group([group([score(">=", 0.3)], "none")]), range)).toBe(
      0.1,
    );
    expect(scoreFloor(group([score(">=", 0.7)], "any"), range)).toBe(0.1);
    const neighbourTree = group([
      {
        kind: "neighbors",
        quant: "no",
        count: 0,
        hops: 1,
        where: group([score(">=", 0.9)]),
      },
    ]);
    expect(scoreFloor(neighbourTree, range)).toBe(0.1);
  });

  it("lowers and raises the threshold by whole 0.05 steps", () => {
    expect(lowerEndThreshold(0.3)).toBe(0.25);
    expect(lowerEndThreshold(0)).toBe(0);
    expect(raiseEndThreshold(0.25, 0.3)).toBe(0.3);
    expect(raiseEndThreshold(0.3, 0.3)).toBe(0.3);
  });

  it("checkOutcome continues with the best-scoring passing candidate", () => {
    const found = [
      candidate({ lineId: 1n, score: 0.4 }),
      candidate({ lineId: 2n, score: 0.8 }),
      candidate({ lineId: 3n, score: 0.9 }),
    ];
    const outcome = checkOutcome(found, new Set(), (c) => c.lineId !== 3n);
    expect(outcome).toEqual({ kind: "continue", candidate: found[1] });
  });

  it("checkOutcome waits when none passes and one is unknown", () => {
    const found = [candidate({ lineId: 1n }), candidate({ lineId: 2n })];
    const outcome = checkOutcome(found, new Set(), (c) =>
      c.lineId === 1n ? false : undefined,
    );
    expect(outcome).toEqual({ kind: "waiting" });
  });

  it("checkOutcome ends when nothing passes", () => {
    expect(checkOutcome([candidate()], new Set(), () => false)).toEqual({
      kind: "end",
    });
    expect(checkOutcome([], new Set(), () => true)).toEqual({ kind: "end" });
  });

  it("checkOutcome ignores decided candidates", () => {
    const found = [
      candidate({ lineId: 1n }),
      candidate({ lineId: 2n, score: 0.1 }),
    ];
    expect(checkOutcome(found, new Set([1n]), () => true)).toEqual({
      kind: "continue",
      candidate: found[1],
    });
    expect(checkOutcome(found, new Set([1n, 2n]), () => true)).toEqual({
      kind: "end",
    });
  });

  it("a score equal to the threshold passes", () => {
    const verdict = endCheckVerdict(
      group([]),
      FULL_SCORE_RANGE,
      0.25,
      NOTHING_KNOWN,
      NO_GRAPH,
    );
    expect(verdict(candidate({ score: 0.25 }))).toBe(true);
    expect(verdict(candidate({ score: 0.2 }))).toBe(false);
  });

  it("a score above range high fails", () => {
    const verdict = endCheckVerdict(
      group([]),
      [0, 0.8],
      0.25,
      NOTHING_KNOWN,
      NO_GRAPH,
    );
    expect(verdict(candidate({ score: 0.8 }))).toBe(true);
    expect(verdict(candidate({ score: 0.85 }))).toBe(false);
  });

  it("a score condition in the tree does not apply", () => {
    const verdict = endCheckVerdict(
      group([score(">=", 0.3)]),
      FULL_SCORE_RANGE,
      0.25,
      NOTHING_KNOWN,
      NO_GRAPH,
    );
    expect(verdict(candidate({ score: 0.26 }))).toBe(true);
  });
});
