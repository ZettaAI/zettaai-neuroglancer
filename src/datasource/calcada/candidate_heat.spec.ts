import { describe, expect, it } from "vitest";
import type {
  PieceClasses,
  PieceOverview,
} from "#src/datasource/calcada/candidate_heat.js";
import {
  SEMANTIC_FAIL_COLOR,
  describePartner,
  SEMANTIC_UNKNOWN_COLOR,
  heatColor,
  overviewColors,
  partnerColors,
  totalCandidates,
  semanticVerdict,
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
  it("cools toward red and warms toward green", () => {
    expect(red(heatColor(0))).toBeGreaterThan(red(heatColor(0.5)));
    expect(red(heatColor(0.5))).toBeGreaterThan(red(heatColor(1)));
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

describe("overviewColors", () => {
  it("keeps the three outcomes apart", () => {
    const colors = overviewColors(
      [
        piece({
          pieceId: 1n,
          bestScore: 0.9,
          hasInfo: true,
          classes: { ...noClasses, axon: 100 },
        }),
        piece({
          pieceId: 2n,
          bestScore: 0.9,
          hasInfo: true,
          classes: { ...noClasses, dendrite: 100 },
        }),
        piece({ pieceId: 3n, bestScore: 0.9, hasInfo: false }),
      ],
      "axon",
      0.8,
    );
    expect(colors.get(1n)).toBe(heatColor(0.9));
    expect(colors.get(2n)).toBe(SEMANTIC_FAIL_COLOR);
    expect(colors.get(3n)).toBe(SEMANTIC_UNKNOWN_COLOR);
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

describe("overviewColors without semantics", () => {
  it("keeps showing scores instead of flattening to one colour", () => {
    const colors = overviewColors(
      [
        piece({ pieceId: 1n, bestScore: 0.9, hasInfo: false }),
        piece({ pieceId: 2n, bestScore: 0.1, hasInfo: false }),
      ],
      "axon",
      0.8,
    );
    expect(colors.get(1n)).toBe(heatColor(0.9));
    expect(colors.get(2n)).toBe(heatColor(0.1));
  });

  it("still applies the filter once any piece has semantics", () => {
    const colors = overviewColors(
      [
        piece({
          pieceId: 1n,
          bestScore: 0.9,
          hasInfo: true,
          classes: { ...noClasses, dendrite: 100 },
        }),
        piece({ pieceId: 2n, bestScore: 0.9, hasInfo: false }),
      ],
      "axon",
      0.8,
    );
    expect(colors.get(1n)).toBe(SEMANTIC_FAIL_COLOR);
    expect(colors.get(2n)).toBe(SEMANTIC_UNKNOWN_COLOR);
  });
});

describe("partnerColors", () => {
  it("colours the candidate's own piece by how good the proposal is", () => {
    const colors = partnerColors(
      [
        piece({
          pieceId: 1n,
          bestScore: 0.9,
          bestPartnerPiece: 77n,
          candidateCount: 3,
        }),
      ],
      "any",
      0.8,
    );
    expect(colors.get(77n)).toBe(heatColor(0.9));
    expect(colors.has(1n)).toBe(false);
  });

  it("leaves out pieces that offer nothing", () => {
    const colors = partnerColors(
      [piece({ pieceId: 1n, bestPartnerPiece: 0n, candidateCount: 0 })],
      "any",
      0.8,
    );
    expect(colors.size).toBe(0);
  });
});

describe("totalCandidates", () => {
  it("sums what each piece still offers", () => {
    expect(
      totalCandidates([
        piece({ candidateCount: 3 }),
        piece({ candidateCount: 4 }),
      ]),
    ).toBe(7);
  });
});
