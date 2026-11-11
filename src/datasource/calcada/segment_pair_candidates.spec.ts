import { describe, expect, it } from "vitest";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import {
  pairCandidates,
  SegmentPairCandidates,
} from "#src/datasource/calcada/segment_pair_candidates.js";

const noClasses = {
  perikaryon: 0,
  dendrite: 0,
  axon: 0,
  glia: 0,
  vasculature: 0,
  nucleus: 0,
  ecs: 0,
  other: 0,
};

function candidate(
  lineId: number,
  score: number,
  partnerRootId: bigint,
  label = "",
): EdgeCandidate {
  return {
    lineId: BigInt(lineId),
    score,
    selfPieceId: 1n,
    partnerPieceId: 2n,
    partnerRootId,
    pointA: Float32Array.of(0, 0, 0),
    pointB: Float32Array.of(2, 4, 6),
    nInterfaces: 1,
    modelDecision: "defer",
    label,
    partnerVoxels: 0,
    partnerClasses: noClasses,
    partnerHasInfo: false,
    selfVoxels: 0,
    selfClasses: noClasses,
    selfHasInfo: false,
  };
}

describe("pairCandidates", () => {
  it("keeps one row per pair of segments, best first", () => {
    const rows = pairCandidates(
      new Map([
        [10n, [candidate(1, 0.4, 20n), candidate(2, 0.9, 30n, "thin-neck")]],
        [20n, [candidate(1, 0.4, 10n)]],
        [30n, [candidate(2, 0.9, 10n, "thin-neck"), candidate(3, 0.6, 20n)]],
      ]),
    );
    expect(
      rows.map((row) => [row.lineId, row.rootA, row.rootB, row.label]),
    ).toEqual([
      [2n, 10n, 30n, "thin-neck"],
      [3n, 20n, 30n, ""],
      [1n, 10n, 20n, ""],
    ]);
  });

  it("keeps a pair's best candidate when it has several", () => {
    const rows = pairCandidates(
      new Map([
        [10n, [candidate(1, 0.4, 20n)]],
        [20n, [candidate(5, 0.7, 10n)]],
      ]),
    );
    expect(rows.map((row) => row.lineId)).toEqual([5n]);
  });
});

describe("SegmentPairCandidates", () => {
  function session(roots: bigint[], answer = new Map()) {
    const visited: Float32Array[] = [];
    const asked: bigint[][] = [];
    const pairs = new SegmentPairCandidates({
      selectedRoots: () => roots,
      fetchBetween: async (asking) => {
        asked.push(asking);
        return answer;
      },
      goTo: (point) => visited.push(point),
    });
    return { pairs, visited, asked };
  }

  it("asks for at least two segments and fetches nothing", async () => {
    const { pairs, asked } = session([10n]);
    await pairs.list();
    expect(asked).toEqual([]);
    expect(pairs.rows).toEqual([]);
    expect(pairs.status).toBe("Select at least two segments");
  });

  it("lists the selected segments' pairs and goes to a contact", async () => {
    const { pairs, visited, asked } = session(
      [10n, 20n],
      new Map([[10n, [candidate(1, 0.4, 20n)]]]),
    );
    await pairs.list();
    expect(asked).toEqual([[10n, 20n]]);
    expect(pairs.rows).toHaveLength(1);
    expect(pairs.status).toBe("1 pair between 2 segments");

    pairs.goTo(pairs.rows[0]);
    expect(Array.from(visited[0])).toEqual([1, 2, 3]);
  });
});
