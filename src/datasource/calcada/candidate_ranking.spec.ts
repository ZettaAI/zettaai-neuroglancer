import { describe, expect, it } from "vitest";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import {
  dropDecided,
  nextCandidate,
} from "#src/datasource/calcada/candidate_ranking.js";

function candidate(lineId: bigint, score: number): EdgeCandidate {
  return {
    lineId,
    score,
    selfPieceId: 1n,
    partnerPieceId: 2n,
    partnerRootId: 3n,
    pointA: Float32Array.of(0, 0, 0),
    pointB: Float32Array.of(1, 1, 1),
    nInterfaces: 1,
    modelDecision: "defer",
  };
}

describe("candidate ranking", () => {
  it("drops locally decided candidates", () => {
    const list = [candidate(1n, 0.9), candidate(2n, 0.7)];
    expect(dropDecided(list, new Set([1n])).map((c) => c.lineId)).toEqual([2n]);
  });

  it("returns the highest scoring undecided candidate", () => {
    const list = [candidate(1n, 0.9), candidate(2n, 0.7)];
    expect(nextCandidate(list, new Set())?.lineId).toBe(1n);
    expect(nextCandidate(list, new Set([1n]))?.lineId).toBe(2n);
  });

  it("returns undefined when everything is decided", () => {
    const list = [candidate(1n, 0.9)];
    expect(nextCandidate(list, new Set([1n]))).toBeUndefined();
  });

  it("does not assume the server ordered the list", () => {
    const list = [candidate(1n, 0.4), candidate(2n, 0.95)];
    expect(nextCandidate(list, new Set())?.lineId).toBe(2n);
  });
});
