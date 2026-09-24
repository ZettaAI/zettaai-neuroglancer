import { describe, expect, it } from "vitest";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import {
  nextEntry,
  prependChildren,
  prunePool,
  remainingCount,
  seedPool,
} from "#src/datasource/calcada/candidate_traversal.js";

function candidate(
  lineId: number,
  score: number,
  selfPiece = 1,
  partnerPiece = 2,
): EdgeCandidate {
  return {
    lineId: BigInt(lineId),
    score,
    selfPieceId: BigInt(selfPiece),
    partnerPieceId: BigInt(partnerPiece),
    partnerRootId: BigInt(partnerPiece * 1000),
    pointA: Float32Array.of(0, 0, 0),
    pointB: Float32Array.of(1, 1, 1),
    nInterfaces: 1,
    modelDecision: "defer",
    partnerVoxels: 0,
    partnerClasses: {
      perikaryon: 0,
      dendrite: 0,
      axon: 0,
      glia: 0,
      vasculature: 0,
      nucleus: 0,
      ecs: 0,
      other: 0,
    },
    partnerHasInfo: false,
  };
}

const lineIds = (pool: { candidate: EdgeCandidate }[]) =>
  pool.map((entry) => Number(entry.candidate.lineId));

describe("seedPool", () => {
  it("orders by score, best first", () => {
    const pool = seedPool([candidate(1, 0.3), candidate(2, 0.9)]);
    expect(lineIds(pool)).toEqual([2, 1]);
    expect(pool.every((entry) => entry.depth === 0)).toBe(true);
  });
});

describe("prependChildren", () => {
  it("puts a merged segment's own candidates ahead of everything else", () => {
    // The whole point of depth-first: a child of 0.1 still beats a sibling of
    // 0.98, because the branch just taken has to be exhausted first.
    const pool = seedPool([candidate(1, 0.98), candidate(2, 0.5)]);
    const next = prependChildren(pool, [candidate(3, 0.1)], 0, new Set());
    expect(lineIds(next)).toEqual([3, 1, 2]);
  });

  it("orders the children among themselves by score", () => {
    const pool = seedPool([candidate(1, 0.9)]);
    const next = prependChildren(
      pool,
      [candidate(3, 0.2), candidate(4, 0.7)],
      0,
      new Set(),
    );
    expect(lineIds(next)).toEqual([4, 3, 1]);
  });

  it("records the children one level deeper", () => {
    const pool = prependChildren(
      seedPool([candidate(1, 0.9)]),
      [candidate(3, 0.5)],
      2,
      new Set(),
    );
    expect(pool[0].depth).toBe(3);
  });

  it("drops children already in the pool or already answered", () => {
    const pool = seedPool([candidate(1, 0.9)]);
    const next = prependChildren(
      pool,
      [candidate(1, 0.9), candidate(2, 0.8), candidate(3, 0.7)],
      0,
      new Set([2n]),
    );
    expect(lineIds(next)).toEqual([3, 1]);
  });
});

describe("nextEntry", () => {
  it("follows pool order rather than the best score", () => {
    const pool = prependChildren(
      seedPool([candidate(1, 0.99)]),
      [candidate(2, 0.2)],
      0,
      new Set(),
    );
    expect(Number(nextEntry(pool, new Set())!.candidate.lineId)).toBe(2);
  });

  it("falls back to the ancestor once the branch is answered", () => {
    const pool = prependChildren(
      seedPool([candidate(1, 0.99)]),
      [candidate(2, 0.2)],
      0,
      new Set(),
    );
    expect(Number(nextEntry(pool, new Set([2n]))!.candidate.lineId)).toBe(1);
  });

  it("reports nothing once every entry is answered", () => {
    const pool = seedPool([candidate(1, 0.9)]);
    expect(nextEntry(pool, new Set([1n]))).toBeUndefined();
    expect(remainingCount(pool, new Set([1n]))).toBe(0);
  });
  it("skips entries below the score threshold without losing them", () => {
    const pool = prependChildren(
      seedPool([candidate(1, 0.9)]),
      [candidate(2, 0.4)],
      0,
      new Set(),
    );
    expect(Number(nextEntry(pool, new Set(), 0.5)!.candidate.lineId)).toBe(1);
    expect(remainingCount(pool, new Set(), 0.5)).toBe(1);
    // Lowering the threshold brings the skipped child back ahead of its
    // ancestor, where the depth-first walk had it.
    expect(Number(nextEntry(pool, new Set(), 0.3)!.candidate.lineId)).toBe(2);
    expect(remainingCount(pool, new Set(), 0.3)).toBe(2);
  });
});

describe("prunePool", () => {
  it("drops entries the predicate rejects", () => {
    const pool = seedPool([
      candidate(1, 0.9, 10, 20),
      candidate(2, 0.8, 11, 21),
    ]);
    const kept = prunePool(pool, (entry) => entry.selfPieceId === 10n);
    expect(lineIds(kept)).toEqual([1]);
  });
});
