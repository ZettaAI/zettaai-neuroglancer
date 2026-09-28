import { describe, expect, it } from "vitest";
import type {
  PieceClasses,
  PieceOverview,
} from "#src/datasource/calcada/candidate_heat.js";
import {
  describePiece,
  flaggedPieceCount,
  heatColor,
  semanticVerdict,
  splitErrorColors,
  applicableToCandidates,
  candidatePasses,
} from "#src/datasource/calcada/candidate_heat.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";

const noClasses: PieceClasses = {
  perikaryon: 0,
  dendrite: 0,
  axon: 0,
  glia: 0,
  vasculature: 0,
  nucleus: 0,
  ecs: 0,
  other: 0,
};

function piece(overrides: Partial<PieceOverview> = {}): PieceOverview {
  return {
    pieceId: 1n,
    bestScore: 0,
    bestPartnerPiece: 0n,
    bestPartnerRoot: 0n,
    partnerClasses: noClasses,
    partnerHasInfo: false,
    candidateCount: 0,
    voxelCount: 100,
    classes: noClasses,
    hasInfo: false,
    ...overrides,
  };
}

// Packed as (a<<24)|(b<<16)|(g<<8)|r, so red is the low byte.
const red = (color: bigint) => Number(color & 0xffn);

describe("heatColor", () => {
  it("runs from green for no candidate to red for a strong one", () => {
    expect(red(heatColor(0))).toBeLessThan(red(heatColor(0.5)));
    expect(red(heatColor(0.5))).toBeLessThan(red(heatColor(1)));
  });

  it("clamps scores outside the scale", () => {
    expect(heatColor(-5)).toBe(heatColor(0));
    expect(heatColor(5)).toBe(heatColor(1));
  });
});

describe("semanticVerdict", () => {
  const axonHeavy = { ...noClasses, axon: 80, dendrite: 20 };

  it("passes everything when no class is asked for", () => {
    expect(semanticVerdict(piece(), "any", 0.8)).toBe("pass");
  });

  it("compares the class against the piece's own total", () => {
    const p = piece({ classes: axonHeavy, hasInfo: true });
    expect(semanticVerdict(p, "axon", 0.8)).toBe("pass");
    expect(semanticVerdict(p, "axon", 0.9)).toBe("fail");
    expect(semanticVerdict(p, "dendrite", 0.5)).toBe("fail");
  });

  it("says unknown rather than fail when there are no semantics", () => {
    expect(semanticVerdict(piece({ hasInfo: false }), "axon", 0.8)).toBe(
      "unknown",
    );
    // A row that exists but sums to zero is just as uninformative.
    expect(semanticVerdict(piece({ hasInfo: true }), "axon", 0.8)).toBe(
      "unknown",
    );
  });
});

describe("describePiece", () => {
  it("gives the size and every class as a share, largest first", () => {
    expect(
      describePiece({
        voxels: 34871,
        classes: { ...noClasses, dendrite: 88, axon: 9, glia: 3 },
        hasInfo: true,
      }),
    ).toBe("34,871 vx · dendrite 88% · axon 9% · glia 3%");
  });

  it("leaves out classes under one percent", () => {
    expect(
      describePiece({
        voxels: 10,
        classes: { ...noClasses, axon: 995, other: 5 },
        hasInfo: true,
      }),
    ).toBe("10 vx · axon 100%");
  });

  it("says so rather than guessing when the graph has no semantics", () => {
    expect(
      describePiece({ voxels: 5, classes: noClasses, hasInfo: false }),
    ).toBe("5 vx · no semantics");
  });
});

const dendrite: PieceClasses = { ...noClasses, dendrite: 9, axon: 1 };
const axon: PieceClasses = { ...noClasses, axon: 9, dendrite: 1 };
const anyClass = { wanted: "any" as const, minFraction: 0.8, minVoxels: 0 };
const any = { source: anyClass, target: anyClass, minScore: 0 };
const only = (wanted: "axon" | "dendrite") => ({
  wanted,
  minFraction: 0.8,
  minVoxels: 0,
});

describe("splitErrorColors", () => {
  it("paints a piece by its best candidate, and a piece with none green", () => {
    const colors = splitErrorColors(
      [
        piece({ pieceId: 1n, bestScore: 0.9, candidateCount: 2 }),
        piece({ pieceId: 2n }),
      ],
      any,
    );
    expect(colors.get(1n)).toBe(heatColor(0.9));
    expect(colors.get(2n)).toBe(heatColor(0));
  });

  it("does not flag a piece whose best candidate is under the shared threshold", () => {
    const pieces = [piece({ pieceId: 1n, bestScore: 0.6, candidateCount: 1 })];
    expect(splitErrorColors(pieces, { ...any, minScore: 0.7 }).get(1n)).toBe(
      heatColor(0),
    );
    expect(flaggedPieceCount(pieces, { ...any, minScore: 0.7 })).toBe(0);
    expect(flaggedPieceCount(pieces, { ...any, minScore: 0.5 })).toBe(1);
  });

  const mixed = [
    piece({
      pieceId: 1n,
      bestScore: 0.9,
      candidateCount: 1,
      classes: axon,
      hasInfo: true,
      partnerClasses: dendrite,
      partnerHasInfo: true,
    }),
    piece({
      pieceId: 2n,
      bestScore: 0.9,
      candidateCount: 1,
      classes: dendrite,
      hasInfo: true,
      partnerClasses: axon,
      partnerHasInfo: true,
    }),
  ];

  it("judges the target class on the candidate", () => {
    const filter = { ...any, target: only("dendrite") };
    expect(splitErrorColors(mixed, filter).get(1n)).toBe(heatColor(0.9));
    expect(splitErrorColors(mixed, filter).get(2n)).toBe(heatColor(0));
  });

  it("judges the source class on the piece offering it", () => {
    const filter = { ...any, source: only("dendrite") };
    expect(splitErrorColors(mixed, filter).get(1n)).toBe(heatColor(0));
    expect(splitErrorColors(mixed, filter).get(2n)).toBe(heatColor(0.9));
  });

  it("needs both sides when both are named", () => {
    const axonIntoAxon = { ...any, source: only("axon"), target: only("axon") };
    expect(flaggedPieceCount(mixed, axonIntoAxon)).toBe(0);
    const axonIntoDendrite = {
      ...any,
      source: only("axon"),
      target: only("dendrite"),
    };
    expect(flaggedPieceCount(mixed, axonIntoDendrite)).toBe(1);
  });

  it("skips pieces smaller than the seed-side minimum", () => {
    const pieces = [
      piece({ pieceId: 1n, bestScore: 0.9, candidateCount: 1, voxelCount: 50 }),
      piece({
        pieceId: 2n,
        bestScore: 0.9,
        candidateCount: 1,
        voxelCount: 500,
      }),
    ];
    const filter = { ...any, source: { ...anyClass, minVoxels: 100 } };
    expect(splitErrorColors(pieces, filter).get(1n)).toBe(heatColor(0));
    expect(splitErrorColors(pieces, filter).get(2n)).toBe(heatColor(0.9));
  });

  it("ignores the class filter on a graph with no semantics at all", () => {
    const pieces = [piece({ pieceId: 1n, bestScore: 0.9, candidateCount: 1 })];
    expect(
      flaggedPieceCount(pieces, {
        ...any,
        source: only("dendrite"),
        target: only("dendrite"),
      }),
    ).toBe(1);
  });
});

describe("candidatePasses", () => {
  const candidate = (
    score: number,
    self: PieceClasses,
    partner: PieceClasses,
  ) =>
    ({
      score,
      selfVoxels: 100,
      selfClasses: self,
      selfHasInfo: true,
      partnerVoxels: 100,
      partnerClasses: partner,
      partnerHasInfo: true,
    }) as EdgeCandidate;

  it("applies the score and both class filters", () => {
    const axonToAxon = candidate(0.9, axon, axon);
    expect(candidatePasses(axonToAxon, { ...any, source: only("axon") })).toBe(
      true,
    );
    expect(
      candidatePasses(axonToAxon, { ...any, target: only("dendrite") }),
    ).toBe(false);
    expect(candidatePasses(axonToAxon, { ...any, minScore: 0.95 })).toBe(false);
  });

  it("applies a minimum size on each end", () => {
    const axonToAxon = candidate(0.9, axon, axon);
    const bigger = (minVoxels: number) => ({ ...anyClass, minVoxels });
    expect(candidatePasses(axonToAxon, { ...any, source: bigger(100) })).toBe(
      true,
    );
    expect(candidatePasses(axonToAxon, { ...any, source: bigger(101) })).toBe(
      false,
    );
    expect(candidatePasses(axonToAxon, { ...any, target: bigger(101) })).toBe(
      false,
    );
  });

  it("stops filtering a side that no queued candidate has semantics for", () => {
    const unknown = {
      score: 0.9,
      selfVoxels: 100,
      partnerVoxels: 100,
      selfClasses: noClasses,
      selfHasInfo: false,
      partnerClasses: noClasses,
      partnerHasInfo: false,
    } as EdgeCandidate;
    const filter = applicableToCandidates({ ...any, source: only("axon") }, [
      unknown,
    ]);
    expect(candidatePasses(unknown, filter)).toBe(true);
  });
});
