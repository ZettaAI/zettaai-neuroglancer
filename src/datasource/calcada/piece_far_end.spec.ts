import { describe, expect, it } from "vitest";
import { pieceFarEndNm } from "#src/datasource/calcada/piece_far_end.js";
import type { PieceCovariance } from "#src/datasource/calcada/piece_geometry.js";

const ROD_LENGTH = 120;
// A uniform rod of length L has variance L^2/12 along it.
const ROD_VARIANCE = (ROD_LENGTH * ROD_LENGTH) / 12;
const UNIT_RESOLUTION: [number, number, number] = [1, 1, 1];
const NO_SPREAD: PieceCovariance = {
  xx: 0,
  yy: 0,
  zz: 0,
  xy: 0,
  xz: 0,
  yz: 0,
};

function rodAlongX(variance = ROD_VARIANCE): PieceCovariance {
  return { ...NO_SPREAD, xx: variance };
}

function expectPoint(
  actual: readonly number[] | undefined,
  expected: readonly number[],
) {
  expect(actual).toBeDefined();
  actual!.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
}

describe("pieceFarEndNm", () => {
  it("gives the far end of a rod along x", () => {
    const farEnd = pieceFarEndNm(
      [100, 0, 0],
      rodAlongX(),
      UNIT_RESOLUTION,
      [40, 0, 0],
    );
    expectPoint(farEnd, [100 + ROD_LENGTH / 2, 0, 0]);
  });

  it("picks the side away from the contact", () => {
    const farEnd = pieceFarEndNm(
      [100, 0, 0],
      rodAlongX(),
      UNIT_RESOLUTION,
      [160, 0, 0],
    );
    expectPoint(farEnd, [100 - ROD_LENGTH / 2, 0, 0]);
  });

  it("scales the centroid and covariance by an anisotropic resolution", () => {
    const resolution: [number, number, number] = [4, 4, 40];
    const lengthVoxels = 30;
    const farEnd = pieceFarEndNm(
      [10, 20, 5],
      { ...NO_SPREAD, zz: (lengthVoxels * lengthVoxels) / 12 },
      resolution,
      [40, 80, 0],
    );
    expectPoint(farEnd, [40, 80, 200 + (lengthVoxels / 2) * 40]);
  });

  it("follows a diagonal axis whose off-diagonal terms carry the shape", () => {
    const half = ROD_VARIANCE / 2;
    const farEnd = pieceFarEndNm(
      [0, 0, 0],
      { ...NO_SPREAD, xx: half, yy: half, xy: half },
      UNIT_RESOLUTION,
      [-1, -1, 0],
    );
    const offset = ROD_LENGTH / 2 / Math.SQRT2;
    expectPoint(farEnd, [offset, offset, 0]);
  });

  it("gives nothing for a piece with no spread", () => {
    expect(
      pieceFarEndNm([1, 2, 3], NO_SPREAD, UNIT_RESOLUTION, [0, 0, 0]),
    ).toBeUndefined();
  });

  it("gives nothing for a round piece, which has no axis", () => {
    expect(
      pieceFarEndNm(
        [1, 2, 3],
        { ...NO_SPREAD, xx: 5, yy: 5, zz: 5 },
        UNIT_RESOLUTION,
        [0, 0, 0],
      ),
    ).toBeUndefined();
  });

  it("gives nothing for a disc, whose top two spreads are equal", () => {
    expect(
      pieceFarEndNm(
        [0, 0, 0],
        { ...NO_SPREAD, xx: 5, yy: 5, zz: 1 },
        UNIT_RESOLUTION,
        [0, 0, 0],
      ),
    ).toBeUndefined();
  });

  it("gives nothing for a near-disc that is barely longer one way", () => {
    expect(
      pieceFarEndNm(
        [0, 0, 0],
        { ...NO_SPREAD, xx: 1, yy: 0.95, zz: 0.1 },
        UNIT_RESOLUTION,
        [0, 0, 0],
      ),
    ).toBeUndefined();
  });

  it("gives the far end of a piece twice as spread one way as the next", () => {
    const farEnd = pieceFarEndNm(
      [0, 0, 0],
      { ...NO_SPREAD, xx: 2, yy: 1 },
      UNIT_RESOLUTION,
      [-1, 0, 0],
    );
    expectPoint(farEnd, [Math.sqrt(3 * 2), 0, 0]);
  });

  it("gives nothing when the centroid or resolution is not a number", () => {
    expect(
      pieceFarEndNm([NaN, 0, 0], rodAlongX(), UNIT_RESOLUTION, [0, 0, 0]),
    ).toBeUndefined();
    expect(
      pieceFarEndNm([1, 2, 3], rodAlongX(), [1, NaN, 1], [0, 0, 0]),
    ).toBeUndefined();
  });
});
