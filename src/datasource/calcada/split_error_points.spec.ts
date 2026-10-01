import { describe, expect, it } from "vitest";
import type { PieceOverview } from "#src/datasource/calcada/candidate_heat.js";
import { splitErrorPoints } from "#src/datasource/calcada/split_error_points.js";

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

const piece = (
  pieceId: bigint,
  bestScore: number,
  center?: [number, number, number],
): PieceOverview => ({
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
  center,
});

describe("splitErrorPoints", () => {
  it("puts a point on each flagged piece where the server placed it", () => {
    const points = splitErrorPoints(
      [piece(1n, 0.9, [10, 0, 0]), piece(2n, 0.5, [20, 0, 0]), piece(3n, 0.4)],
      2n,
    );
    expect(points).toEqual([
      {
        pieceId: 1n,
        position: Float32Array.of(10, 0, 0),
        score: 0.9,
        focused: false,
      },
      {
        pieceId: 2n,
        position: Float32Array.of(20, 0, 0),
        score: 0.5,
        focused: true,
      },
    ]);
  });
});
