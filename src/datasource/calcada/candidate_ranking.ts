/**
 * Client-side view of an AI-proposed merge.
 *
 * The server does the real work: it ranks by score, drops candidates whose
 * partner already sits in the seed segment, drops those already accepted or
 * rejected, and keeps only the best interface per partner segment. The client
 * only suppresses verdicts issued in this session, before their refetch lands.
 */
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
}

export function dropDecided(
  candidates: EdgeCandidate[],
  decided: Set<bigint>,
): EdgeCandidate[] {
  return candidates.filter((c) => !decided.has(c.lineId));
}

/**
 * The best remaining candidate. Picks by score rather than trusting the
 * server's order, so a locally rejected top candidate cannot leave the list
 * mis-ranked.
 */
export function nextCandidate(
  candidates: EdgeCandidate[],
  decided: Set<bigint>,
): EdgeCandidate | undefined {
  let best: EdgeCandidate | undefined;
  for (const c of dropDecided(candidates, decided)) {
    if (best === undefined || c.score > best.score) best = c;
  }
  return best;
}
