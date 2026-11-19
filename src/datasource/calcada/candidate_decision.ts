import type { DecisionTiming } from "#src/datasource/calcada/decision_timing.js";

/** "ambiguous": the contact cannot be judged, which keeps it out of training data. */
export type CandidateVerdict = "accept" | "reject" | "defer" | "ambiguous";

export interface CandidateDecisionRequest {
  lineId: bigint;
  decision: CandidateVerdict;
  operationId?: number;
  timing?: DecisionTiming;
  depth?: number;
}

export function candidateDecisionBody(
  request: CandidateDecisionRequest,
): string {
  const { lineId, decision, operationId, timing, depth } = request;
  return JSON.stringify({
    line_id: String(lineId),
    decision,
    ...(operationId === undefined ? {} : { operation_id: operationId }),
    ...(timing === undefined
      ? {}
      : {
          think_ms: timing.thinkMs,
          wait_ms: timing.waitMs,
          session_id: timing.sessionId,
        }),
    ...(depth === undefined ? {} : { depth }),
  });
}
