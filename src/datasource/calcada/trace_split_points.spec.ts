import { describe, expect, it } from "vitest";
import type { PieceOverview } from "#src/datasource/calcada/candidate_heat.js";
import type { SplitErrorPoint } from "#src/datasource/calcada/split_error_points.js";
import {
  splitPointsTarget,
  TraceSplitPoints,
} from "#src/datasource/calcada/trace_split_points.js";

const classes = {
  perikaryon: 0,
  dendrite: 0,
  axon: 0,
  glia: 0,
  vasculature: 0,
  nucleus: 0,
  ecs: 0,
  other: 0,
};

const piece = (pieceId: bigint, bestScore: number): PieceOverview => ({
  pieceId,
  bestScore,
  bestPartnerPiece: 0n,
  bestPartnerRoot: 0n,
  bestPartnerVoxels: 0,
  partnerClasses: classes,
  partnerHasInfo: false,
  candidateCount: 1,
  voxelCount: 100,
  classes,
  hasInfo: false,
  contact: [Number(pieceId), 0, 0],
});

function harness(overviews: Map<bigint, PieceOverview[]>) {
  const fetched: bigint[] = [];
  const drawn: SplitErrorPoint[][] = [];
  let threshold = 0;
  const points = new TraceSplitPoints({
    fetchOverview: async (root) => {
      fetched.push(root);
      return overviews.get(root) ?? [];
    },
    passesOn: async () => (overview) => overview.bestScore >= threshold,
    draw: (shown) => drawn.push(shown),
    reportError: () => {},
  });
  const ids = () => drawn.at(-1)?.map((point) => point.pieceId);
  return {
    points,
    fetched,
    ids,
    setThreshold: (value: number) => {
      threshold = value;
    },
  };
}

const overviews = new Map([
  [10n, [piece(1n, 0.9), piece(2n, 0.2)]],
  [20n, [piece(3n, 0.7)]],
]);

describe("TraceSplitPoints", () => {
  it("draws the flagged pieces of the seed's and the candidate's segments", async () => {
    const { points, ids } = harness(overviews);
    await points.show([10n, 20n]);
    expect(ids()).toEqual([1n, 3n, 2n]);
  });

  it("scores a segment once while it stays on screen", async () => {
    const { points, fetched } = harness(overviews);
    await points.show([10n, 20n]);
    await points.show([10n]);
    await points.show([10n, 20n]);
    expect(fetched).toEqual([10n, 20n, 20n]);
  });

  it("applies a changed filter without asking the server again", async () => {
    const { points, fetched, ids, setThreshold } = harness(overviews);
    await points.show([10n, 20n]);
    setThreshold(0.5);
    await points.refresh();
    expect(ids()).toEqual([1n, 3n]);
    expect(fetched).toEqual([10n, 20n]);
  });

  it("scores a segment afresh once told it changed", async () => {
    const { points, fetched } = harness(overviews);
    await points.show([10n]);
    points.forget(10n);
    await points.show([10n]);
    expect(fetched).toEqual([10n, 10n]);
  });

  it("takes scores already in hand instead of asking for them", async () => {
    const { points, fetched, ids } = harness(overviews);
    points.prime(10n, [piece(5n, 0.8)]);
    await points.show([10n, 20n]);
    expect(fetched).toEqual([20n]);
    expect(ids()).toEqual([5n, 3n]);
  });

  it("leaves the points alone when clearing what it never drew", () => {
    const { points, ids } = harness(overviews);
    points.clear();
    expect(ids()).toBeUndefined();
  });

  it("draws nothing once cleared, even if a score arrives late", async () => {
    const { points, ids } = harness(overviews);
    const pending = points.show([10n]);
    points.clear();
    await pending;
    expect(ids()).toEqual([]);
  });
});

describe("splitPointsTarget", () => {
  const base = {
    showSplitPoints: true,
    tracing: false,
    aiming: false,
    detectionActive: false,
  };

  it("draws the seed and candidate while tracing", () => {
    expect(splitPointsTarget({ ...base, tracing: true })).toBe("trace");
  });

  it("draws the selected segment while aiming, before any seed", () => {
    expect(splitPointsTarget({ ...base, aiming: true })).toBe("segment");
  });

  it("leaves aiming to detection when detection is drawing them", () => {
    expect(
      splitPointsTarget({ ...base, aiming: true, detectionActive: true }),
    ).toBe("none");
  });

  it("draws nothing with the box unticked or outside the trace", () => {
    expect(
      splitPointsTarget({ ...base, showSplitPoints: false, tracing: true }),
    ).toBe("none");
    expect(splitPointsTarget(base)).toBe("none");
  });
});
