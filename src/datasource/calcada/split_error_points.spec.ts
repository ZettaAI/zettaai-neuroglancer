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
  contact?: [number, number, number],
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
  contact,
});

describe("splitErrorPoints", () => {
  it("puts a point where each flagged candidate touches the segment", () => {
    const focused = piece(2n, 0.5, [20, 0, 0]);
    const points = splitErrorPoints(
      [piece(1n, 0.9, [10, 0, 0]), focused, piece(3n, 0.4)],
      focused,
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

  it("marks only the focused candidate of a piece that offers several", () => {
    const first = piece(1n, 0.9, [10, 0, 0]);
    const second = piece(1n, 0.4, [30, 0, 0]);
    const points = splitErrorPoints([first, second], second);
    expect(points.map((point) => point.focused)).toEqual([false, true]);
  });
});
