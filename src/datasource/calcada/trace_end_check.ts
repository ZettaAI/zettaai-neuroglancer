import type {
  FilterNode,
  GraphFacts,
  GroupNode,
  SemanticsKnown,
  Verdict,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import { subjectVerdict } from "#src/datasource/calcada/candidate_filter_tree.js";
import { edgeCandidateSubject } from "#src/datasource/calcada/candidate_heat.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import type { ScoreRange } from "#src/datasource/calcada/trace_state.js";
import { stepScoreRangeLow } from "#src/datasource/calcada/trace_state.js";

export type TraceDecision = "accept" | "reject";

export type CheckOutcome =
  | { kind: "continue"; candidate: EdgeCandidate }
  | { kind: "end" }
  | { kind: "waiting" };

export const END_THRESHOLD_STEP = 0.05;
const SCORE_FIELD = "score";
const LOWER_BOUND_OPS: readonly string[] = [">=", ">", "between"];
const ALWAYS_TRUE: GroupNode = { kind: "group", op: "all", children: [] };

export function endPointOf(
  after: TraceDecision,
  candidate: EdgeCandidate,
): Float32Array {
  return after === "accept" ? candidate.pointB : candidate.pointA;
}

// A score bound under any, none or neighbours does not bound the candidate.
function mapNode(node: FilterNode): FilterNode {
  if (node.kind === "cond") {
    return node.field === SCORE_FIELD ? { ...ALWAYS_TRUE } : node;
  }
  return node.kind === "group" ? withoutScoreConditions(node) : node;
}

export function withoutScoreConditions(root: GroupNode): GroupNode {
  if (root.op !== "all") return root;
  return { ...root, children: root.children.map(mapNode) };
}

function scoreLowerBounds(node: FilterNode): number[] {
  switch (node.kind) {
    case "cond":
      return node.field === SCORE_FIELD && LOWER_BOUND_OPS.includes(node.op)
        ? [node.value]
        : [];
    case "group":
      return node.op === "all" ? node.children.flatMap(scoreLowerBounds) : [];
    default:
      return [];
  }
}

export function scoreFloor(root: GroupNode, range: ScoreRange): number {
  return Math.max(range[0], ...scoreLowerBounds(root));
}

function stepEndThreshold(threshold: number, direction: 1 | -1): number {
  return stepScoreRangeLow([threshold, 1], direction)[0];
}

export function lowerEndThreshold(threshold: number): number {
  return stepEndThreshold(threshold, -1);
}

export function raiseEndThreshold(threshold: number, floor: number): number {
  return Math.min(floor, stepEndThreshold(threshold, 1));
}

export function checkOutcome(
  found: readonly EdgeCandidate[],
  decided: ReadonlySet<bigint>,
  verdict: (candidate: EdgeCandidate) => Verdict,
): CheckOutcome {
  let best: EdgeCandidate | undefined;
  let undecidedVerdict = false;
  for (const candidate of found) {
    if (decided.has(candidate.lineId)) continue;
    const result = verdict(candidate);
    if (result === undefined) undecidedVerdict = true;
    else if (result && (best === undefined || candidate.score > best.score)) {
      best = candidate;
    }
  }
  if (best !== undefined) return { kind: "continue", candidate: best };
  return { kind: undecidedVerdict ? "waiting" : "end" };
}

export function endCheckVerdict(
  tree: GroupNode,
  range: ScoreRange,
  threshold: number,
  known: SemanticsKnown,
  graph: GraphFacts,
): (candidate: EdgeCandidate) => Verdict {
  const scoreless = withoutScoreConditions(tree);
  return (candidate) =>
    candidate.score >= threshold && candidate.score <= range[1]
      ? subjectVerdict(edgeCandidateSubject(candidate), scoreless, known, graph)
      : false;
}
