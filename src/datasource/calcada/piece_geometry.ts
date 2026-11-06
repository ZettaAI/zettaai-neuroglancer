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
 * @file The shape of a segment's pieces near a point, as `/geometry_in_radius`
 * answers it: each piece's centroid and covariance, in voxels.
 */

import { parseUint64 } from "#src/util/json.js";

export type Point3 = [number, number, number];

/** The six distinct terms of a symmetric 3x3 covariance. */
export interface PieceCovariance {
  xx: number;
  yy: number;
  zz: number;
  xy: number;
  xz: number;
  yz: number;
}

export interface PieceGeometry {
  pieceId: bigint;
  centroidVoxels: Point3;
  covVoxels2: PieceCovariance;
}

export interface RootGeometry {
  rootId: bigint;
  pieces: PieceGeometry[];
}

export interface GeometryInRadius {
  resolutionNm: Point3;
  results: RootGeometry[];
}

// A piece query answers with that piece alone, or with nothing.
const PIECE_QUERY_LIMIT = 1;

// The server writes ids as bare uint64 numbers; JSON.parse would round them.
const BARE_ID_FIELD = /"(root_id|piece_id)"\s*:\s*(\d+)/g;

function point3(value: unknown): Point3 {
  const [x, y, z] = value as unknown[];
  return [Number(x), Number(y), Number(z)];
}

function covariance(value: Record<string, unknown>): PieceCovariance {
  return {
    xx: Number(value.xx),
    yy: Number(value.yy),
    zz: Number(value.zz),
    xy: Number(value.xy),
    xz: Number(value.xz),
    yz: Number(value.yz),
  };
}

export function parseGeometryInRadius(text: string): GeometryInRadius {
  const response = JSON.parse(text.replace(BARE_ID_FIELD, '"$1":"$2"'));
  return {
    resolutionNm: point3(response.resolution_nm),
    results: (response.results ?? []).map((result: any) => ({
      rootId: parseUint64(result.root_id),
      pieces: (result.pieces ?? []).map((piece: any) => ({
        pieceId: parseUint64(piece.piece_id),
        centroidVoxels: point3(piece.centroid_voxels),
        covVoxels2: covariance(piece.cov_voxels2),
      })),
    })),
  };
}

/** Asks for one piece's geometry; the server returns it only if it belongs to `rootId`. */
export function pieceGeometryRequestBody(
  rootId: bigint,
  pieceId: bigint,
  pointNm: readonly number[],
  radiusNm: number,
): string {
  return JSON.stringify({
    queries: [
      {
        root_id: rootId.toString(),
        piece_id: pieceId.toString(),
        point_nm: pointNm,
        radius_nm: radiusNm,
      },
    ],
    limit: PIECE_QUERY_LIMIT,
  });
}
