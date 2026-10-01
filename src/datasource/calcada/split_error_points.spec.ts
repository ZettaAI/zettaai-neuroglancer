import { describe, expect, it } from "vitest";
import type { PieceOverview } from "#src/datasource/calcada/candidate_heat.js";
import type { PieceSphere } from "#src/datasource/calcada/piece_centers.js";
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
});

const sphere = (x: number): PieceSphere => ({ center: [x, 0, 0], radiusNm: 1 });
const halve = (nm: readonly number[]) => Float32Array.from(nm, (v) => v / 2);

describe("splitErrorPoints", () => {
  it("puts a point on each flagged piece whose position is known", () => {
    const points = splitErrorPoints(
      [piece(1n, 0.9), piece(2n, 0.5), piece(3n, 0.4)],
      2n,
      new Map([
        [1n, sphere(10)],
        [2n, sphere(20)],
      ]),
      halve,
    );
    expect(points).toEqual([
      {
        pieceId: 1n,
        position: Float32Array.of(5, 0, 0),
        score: 0.9,
        focused: false,
      },
      {
        pieceId: 2n,
        position: Float32Array.of(10, 0, 0),
        score: 0.5,
        focused: true,
      },
    ]);
  });

  it("skips a piece whose position cannot be placed in the view", () => {
    const points = splitErrorPoints(
      [piece(1n, 0.9)],
      undefined,
      new Map([[1n, sphere(10)]]),
      () => undefined,
    );
    expect(points).toEqual([]);
  });
});
