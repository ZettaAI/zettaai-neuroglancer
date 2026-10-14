/**
 * Client-side view of an AI-proposed merge.
 *
 * The server does the real work: it ranks by score, drops candidates whose
 * partner already sits in the seed segment, drops those already accepted or
 * rejected, and keeps only the best interface per partner segment. What order
 * a proofreader is shown them in is the client's, and lives in
 * `candidate_traversal.ts`.
 */
import type { PieceClasses } from "#src/datasource/calcada/candidate_heat.js";

export interface EdgeCandidate {
  lineId: bigint;
  score: number;
  selfPieceId: bigint;
  partnerPieceId: bigint;
  partnerRootId: bigint;
  pointA: Float32Array;
  pointB: Float32Array;
  nInterfaces: number;
  modelDecision: string;
  /** The piece this candidate would merge in. */
  partnerVoxels: number;
  partnerClasses: PieceClasses;
  partnerHasInfo: boolean;
  /** The seed's own piece at the contact. */
  selfVoxels: number;
  selfClasses: PieceClasses;
  selfHasInfo: boolean;
}

export const SCORE_DIGITS = 2;

/**
 * The strongest merge the candidate's segment has on offer elsewhere — anything
 * but the seed. A seed that beats it is the candidate's own first choice too,
 * which is evidence for the merge; one that only ties it is not.
 */
export function bestAlternative(
  partnerCandidates: readonly EdgeCandidate[],
  seedRoot: bigint,
): EdgeCandidate | undefined {
  let best: EdgeCandidate | undefined;
  for (const candidate of partnerCandidates) {
    if (candidate.partnerRootId === seedRoot) continue;
    if (best === undefined || candidate.score > best.score) best = candidate;
  }
  return best;
}

/**
 * Whether the seed is the candidate's own first choice: it has nothing else, or
 * nothing it would rather join. A tie leaves it a choice, so it is not.
 */
export function describePartnerChoice(
  score: number,
  alternative: EdgeCandidate | undefined,
): { seedIsBest: boolean; text: string } {
  if (alternative === undefined) {
    return { seedIsBest: true, text: "Seed is the candidate's only match" };
  }
  const other = alternative.score.toFixed(SCORE_DIGITS);
  return score > alternative.score
    ? {
        seedIsBest: true,
        text: `Seed is the candidate's best match (next ${other})`,
      }
    : {
        seedIsBest: false,
        text: `Candidate has an alternative: score ${other}`,
      };
}
