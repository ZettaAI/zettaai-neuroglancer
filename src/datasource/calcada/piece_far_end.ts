/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Where a piece ends, estimated from its centroid and covariance alone:
 * the piece is taken as a rod along its principal axis.
 */

import type {
  PieceCovariance,
  Point3,
} from "#src/datasource/calcada/piece_geometry.js";

type Matrix3 = [Point3, Point3, Point3];

// A uniform rod of length L has variance L^2/12 along it: half length sqrt(3 variance).
const VARIANCE_TO_SQUARED_HALF_LENGTH = 3;
// (lambda1 - lambda2) / lambda1 below this: too round to have a far end.
const MIN_ELONGATION = 0.1;
const THIRD_TURN = (2 * Math.PI) / 3;

function covarianceNm(
  covariance: PieceCovariance,
  [resolutionX, resolutionY, resolutionZ]: readonly number[],
): Matrix3 {
  const xy = covariance.xy * resolutionX * resolutionY;
  const xz = covariance.xz * resolutionX * resolutionZ;
  const yz = covariance.yz * resolutionY * resolutionZ;
  return [
    [covariance.xx * resolutionX * resolutionX, xy, xz],
    [xy, covariance.yy * resolutionY * resolutionY, yz],
    [xz, yz, covariance.zz * resolutionZ * resolutionZ],
  ];
}

function determinant([row0, row1, row2]: Matrix3): number {
  return (
    row0[0] * (row1[1] * row2[2] - row1[2] * row2[1]) -
    row0[1] * (row1[0] * row2[2] - row1[2] * row2[0]) +
    row0[2] * (row1[0] * row2[1] - row1[1] * row2[0])
  );
}

function minusDiagonal(matrix: Matrix3, value: number): Matrix3 {
  return matrix.map((row, i) =>
    row.map((entry, j) => (i === j ? entry - value : entry)),
  ) as Matrix3;
}

function cross(a: Point3, b: Point3): Point3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(vector: readonly number[]): number {
  return Math.hypot(...vector);
}

function squaredDistance(a: Point3, b: readonly number[]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Closed form for a symmetric 3x3, largest first; undefined when all three are equal. */
function eigenvalues(matrix: Matrix3): Point3 | undefined {
  const [row0, row1, row2] = matrix;
  const mean = (row0[0] + row1[1] + row2[2]) / 3;
  const offDiagonal = row0[1] ** 2 + row0[2] ** 2 + row1[2] ** 2;
  const spread = Math.sqrt(
    ((row0[0] - mean) ** 2 +
      (row1[1] - mean) ** 2 +
      (row2[2] - mean) ** 2 +
      2 * offDiagonal) /
      6,
  );
  if (!(spread > 0)) return undefined;
  const halfDeterminant =
    determinant(minusDiagonal(matrix, mean)) / spread ** 3 / 2;
  const angle = Math.acos(Math.min(1, Math.max(-1, halfDeterminant))) / 3;
  const largest = mean + 2 * spread * Math.cos(angle);
  const smallest = mean + 2 * spread * Math.cos(angle + THIRD_TURN);
  return [largest, 3 * mean - largest - smallest, smallest];
}

function elongatedEnough([largest, middle]: Point3): boolean {
  return largest > 0 && (largest - middle) / largest >= MIN_ELONGATION;
}

/** The unit eigenvector of a simple `eigenvalue`. */
function eigenvector(matrix: Matrix3, eigenvalue: number): Point3 | undefined {
  const [row0, row1, row2] = minusDiagonal(matrix, eigenvalue);
  const candidates = [cross(row0, row1), cross(row0, row2), cross(row1, row2)];
  const longest = candidates.reduce((best, candidate) =>
    length(candidate) > length(best) ? candidate : best,
  );
  const norm = length(longest);
  if (!(norm > 0)) return undefined;
  return [longest[0] / norm, longest[1] / norm, longest[2] / norm];
}

/** The end of the piece's principal axis farther from `fromNm`, in nanometres. */
export function pieceFarEndNm(
  centroidVoxels: readonly number[],
  covVoxels2: PieceCovariance,
  resolutionNm: readonly number[],
  fromNm: readonly number[],
): Point3 | undefined {
  const covariance = covarianceNm(covVoxels2, resolutionNm);
  const spreads = eigenvalues(covariance);
  if (spreads === undefined || !elongatedEnough(spreads)) return undefined;
  const [eigenvalue] = spreads;
  const axis = eigenvector(covariance, eigenvalue);
  if (axis === undefined) return undefined;
  const halfLength = Math.sqrt(VARIANCE_TO_SQUARED_HALF_LENGTH * eigenvalue);
  const endAt = (side: 1 | -1): Point3 =>
    axis.map(
      (component, i) =>
        centroidVoxels[i] * resolutionNm[i] + side * halfLength * component,
    ) as Point3;
  const forward = endAt(1);
  const backward = endAt(-1);
  const farEnd =
    squaredDistance(forward, fromNm) >= squaredDistance(backward, fromNm)
      ? forward
      : backward;
  return farEnd.every(Number.isFinite) ? farEnd : undefined;
}
