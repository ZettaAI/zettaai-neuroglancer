import { describe, expect, it } from "vitest";
import { subjectPasses } from "#src/datasource/calcada/candidate_filter_tree.js";
import type {
  PieceClasses,
  PieceOverview,
} from "#src/datasource/calcada/candidate_heat.js";
import {
  describePiece,
  flaggedPieceCount,
  heatColor,
  pieceOverviewSubject,
  rankFlaggedPieces,
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
    bestPartnerVoxels: 0,
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

const axon: PieceClasses = { ...noClasses, axon: 9, dendrite: 1 };
const passAll = () => true;

describe("splitErrorColors", () => {
  it("paints a piece by its best candidate, and a piece with none green", () => {
    const colors = splitErrorColors(
      [
        piece({ pieceId: 1n, bestScore: 0.9, candidateCount: 2 }),
        piece({ pieceId: 2n }),
      ],
      passAll,
    );
    expect(colors.get(1n)).toBe(heatColor(0.9));
    expect(colors.get(2n)).toBe(heatColor(0));
  });

  it("paints a piece the filter rejects as fine", () => {
    const pieces = [piece({ pieceId: 1n, bestScore: 0.6, candidateCount: 1 })];
    expect(splitErrorColors(pieces, () => false).get(1n)).toBe(heatColor(0));
    expect(flaggedPieceCount(pieces, () => false)).toBe(0);
  });
});

describe("rankFlaggedPieces", () => {
  it("keeps only flagged pieces, strongest first", () => {
    const ranked = rankFlaggedPieces(
      [
        piece({ pieceId: 1n, bestScore: 0.4, candidateCount: 1 }),
        piece({ pieceId: 2n }),
        piece({ pieceId: 3n, bestScore: 0.9, candidateCount: 1 }),
        piece({ pieceId: 4n, bestScore: 0.6, candidateCount: 1 }),
      ],
      (p) => p.bestScore >= 0.5,
    );
    expect(ranked.map((p) => p.pieceId)).toEqual([3n, 4n]);
  });
});

describe("pieceOverviewSubject", () => {
  it("judges the candidate's size by the best partner's", () => {
    const tree = {
      kind: "group" as const,
      op: "or" as const,
      children: [
        {
          kind: "condition" as const,
          field: { side: "candidate" as const, measure: "voxels" as const },
          cmp: ">=" as const,
          value: 5000,
        },
      ],
    };
    const small = pieceOverviewSubject(piece({ bestPartnerVoxels: 50 }));
    const big = pieceOverviewSubject(piece({ bestPartnerVoxels: 6000 }));
    const known = { seed: true, candidate: true };
    expect(subjectPasses(small, tree, known)).toBe(false);
    expect(subjectPasses(big, tree, known)).toBe(true);
  });

  it("lets a detection row pass a tree through subjectPasses", () => {
    const subject = pieceOverviewSubject(
      piece({
        bestScore: 0.9,
        classes: axon,
        hasInfo: true,
        partnerClasses: axon,
        partnerHasInfo: true,
      }),
    );
    const tree = {
      kind: "group" as const,
      op: "and" as const,
      children: [
        {
          kind: "condition" as const,
          field: {
            side: "candidate" as const,
            measure: "share" as const,
            class: "axon" as const,
          },
          cmp: ">=" as const,
          value: 0.8,
        },
      ],
    };
    expect(subjectPasses(subject, tree, { seed: true, candidate: true })).toBe(
      true,
    );
  });
});
