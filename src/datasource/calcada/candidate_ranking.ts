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
}
