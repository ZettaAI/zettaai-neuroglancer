import { describe, expect, it } from "vitest";
import { candidateDecisionBody } from "#src/datasource/calcada/candidate_decision.js";

describe("candidateDecisionBody", () => {
  it("sends the line id as a string, never a lossy number", () => {
    expect(
      JSON.parse(
        candidateDecisionBody({ lineId: 2n ** 63n + 5n, decision: "reject" }),
      ),
    ).toEqual({
      line_id: "9223372036854775813",
      decision: "reject",
    });
  });

  it("carries operation id, timing and depth when known", () => {
    expect(
      JSON.parse(
        candidateDecisionBody({
          lineId: 7n,
          decision: "accept",
          operationId: 42,
          timing: { thinkMs: 3100, waitMs: 250, sessionId: "s" },
          depth: 3,
        }),
      ),
    ).toEqual({
      line_id: "7",
      decision: "accept",
      operation_id: 42,
      think_ms: 3100,
      wait_ms: 250,
      session_id: "s",
      depth: 3,
    });
  });
});
