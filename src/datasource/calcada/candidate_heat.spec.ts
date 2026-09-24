import { describe, expect, it } from "vitest";
import type {
  PieceClasses,
  PieceOverview,
} from "#src/datasource/calcada/candidate_heat.js";
import {
  describePartner,
  flaggedPieceCount,
  heatColor,
  semanticVerdict,
  splitErrorColors,
} from "#src/datasource/calcada/candidate_heat.js";

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

describe("describePartner", () => {
  const partner = (classes: Partial<PieceClasses>, hasInfo = true) => ({
    partnerVoxels: 2568,
    partnerClasses: { ...noClasses, ...classes },
    partnerHasInfo: hasInfo,
  });

  it("leads with the size and what the piece mostly is", () => {
    const text = describePartner(partner({ axon: 2336, perikaryon: 231 }));
    expect(text).toContain("2,568 vx");
    expect(text).toContain("axon 91%");
  });

  it("adds the axon share when something else dominates", () => {
    const text = describePartner(partner({ dendrite: 700, axon: 300 }));
    expect(text).toContain("dendrite 70%");
    expect(text).toContain("axon 30%");
  });

  it("says so rather than guessing when the graph has no semantics", () => {
    expect(describePartner(partner({}, false))).toContain("no semantics");
    // A row that exists but sums to zero is just as uninformative.
    expect(describePartner(partner({}, true))).toContain("no semantics");
  });
});

const dendrite: PieceClasses = { ...noClasses, dendrite: 9, axon: 1 };
const axon: PieceClasses = { ...noClasses, axon: 9, dendrite: 1 };
const any = { wanted: "any" as const, minFraction: 0.8, minScore: 0 };

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

  it("judges the class on the candidate, not on the piece offering it", () => {
    const pieces = [
      piece({
        pieceId: 1n,
        bestScore: 0.9,
        candidateCount: 1,
        classes: axon,
        partnerClasses: dendrite,
        partnerHasInfo: true,
      }),
      piece({
        pieceId: 2n,
        bestScore: 0.9,
        candidateCount: 1,
        classes: dendrite,
        partnerClasses: axon,
        partnerHasInfo: true,
      }),
    ];
    const filter = { ...any, wanted: "dendrite" as const };
    expect(splitErrorColors(pieces, filter).get(1n)).toBe(heatColor(0.9));
    expect(splitErrorColors(pieces, filter).get(2n)).toBe(heatColor(0));
  });

  it("ignores the class filter on a graph with no semantics at all", () => {
    const pieces = [piece({ pieceId: 1n, bestScore: 0.9, candidateCount: 1 })];
    expect(
      flaggedPieceCount(pieces, { ...any, wanted: "dendrite" as const }),
    ).toBe(1);
  });
});
