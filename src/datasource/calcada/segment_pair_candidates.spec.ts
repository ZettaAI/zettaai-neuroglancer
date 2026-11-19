import { describe, expect, it } from "vitest";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import {
  segmentPairs,
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
  { label = "", hidingDecision = "" } = {},
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
    hidingDecision,
    partnerVoxels: 0,
    partnerClasses: noClasses,
    partnerHasInfo: false,
    selfVoxels: 0,
    selfClasses: noClasses,
    selfHasInfo: false,
  };
}

describe("segmentPairs", () => {
  it("groups every contact under its pair, best pairs and contacts first", () => {
    const pairs = segmentPairs(
      new Map([
        [
          10n,
          [
            candidate(1, 0.4, 20n),
            candidate(4, 0.6, 20n, { hidingDecision: "reject" }),
            candidate(2, 0.9, 30n, { label: "thin-neck" }),
          ],
        ],
        [
          20n,
          [
            candidate(1, 0.4, 10n),
            candidate(4, 0.6, 10n, { hidingDecision: "reject" }),
          ],
        ],
        [30n, [candidate(2, 0.9, 10n, { label: "thin-neck" })]],
      ]),
    );
    expect(
      pairs.map((pair) => [
        pair.rootA,
        pair.rootB,
        pair.contacts.map((contact) => [
          contact.lineId,
          contact.label,
          contact.hidingDecision,
        ]),
      ]),
    ).toEqual([
      [10n, 30n, [[2n, "thin-neck", ""]]],
      [
        10n,
        20n,
        [
          [4n, "", "reject"],
          [1n, "", ""],
        ],
      ],
    ]);
  });
});

describe("SegmentPairCandidates", () => {
  const LIMIT = 2;

  function session(roots: bigint[], answer = new Map()) {
    const visited: Float32Array[] = [];
    const asked: bigint[][] = [];
    const pairs = new SegmentPairCandidates({
      selectedRoots: () => roots,
      dimensions: () => [],
      contactLimit: LIMIT,
      fetchBetween: async (asking) => {
        asked.push(asking);
        return answer;
      },
      goTo: (point) => visited.push(point),
      showSegment: () => () => {},
    });
    return { pairs, visited, asked };
  }

  it("asks for at least two segments and fetches nothing", async () => {
    const { pairs, asked } = session([10n]);
    await pairs.list();
    expect(asked).toEqual([]);
    expect(pairs.pairs).toEqual([]);
    expect(pairs.status).toBe("Select at least two segments");
  });

  it("lists the selected segments' contacts and goes to one", async () => {
    const { pairs, visited, asked } = session(
      [10n, 20n],
      new Map([[10n, [candidate(1, 0.4, 20n)]]]),
    );
    await pairs.list();
    expect(asked).toEqual([[10n, 20n]]);
    expect(pairs.pairs).toHaveLength(1);
    expect(pairs.status).toBe("1 contact in 1 pair between 2 segments");

    pairs.goTo(pairs.pairs[0].contacts[0]);
    expect(Array.from(visited[0])).toEqual([1, 2, 3]);
  });

  it("says when a segment reached the limit and may have more", async () => {
    const { pairs } = session(
      [10n, 20n],
      new Map([[10n, [candidate(1, 0.4, 20n), candidate(2, 0.3, 20n)]]]),
    );
    await pairs.list();
    expect(pairs.status).toBe(
      "2 contacts in 1 pair between 2 segments · a segment reached the limit of 2, so some may be missing",
    );
  });
});
