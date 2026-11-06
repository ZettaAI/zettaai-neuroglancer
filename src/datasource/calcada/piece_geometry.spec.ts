import { describe, expect, it } from "vitest";
import {
  parseGeometryInRadius,
  pieceGeometryRequestBody,
} from "#src/datasource/calcada/piece_geometry.js";

const COVARIANCE = { xx: 1, yy: 2, zz: 3, xy: 4, xz: 5, yz: 6 };

describe("parseGeometryInRadius", () => {
  it("keeps ids above 2^53 exact whether written as numbers or strings", () => {
    const text = `{"resolution_nm":[4,4,40],"results":[{"root_id":72057594037927937,"pieces":[{"piece_id":"144115188075855873","voxel_count":10,"centroid_voxels":[1,2,3],"cov_voxels2":${JSON.stringify(COVARIANCE)},"distance_nm":5},{"piece_id" : 144115188075855875,"voxel_count":1,"centroid_voxels":[4,5,6],"cov_voxels2":${JSON.stringify(COVARIANCE)},"distance_nm":7}],"without_geometry":0,"truncated":false}]}`;
    expect(parseGeometryInRadius(text)).toEqual({
      resolutionNm: [4, 4, 40],
      results: [
        {
          rootId: 72057594037927937n,
          pieces: [
            {
              pieceId: 144115188075855873n,
              centroidVoxels: [1, 2, 3],
              covVoxels2: COVARIANCE,
            },
            {
              pieceId: 144115188075855875n,
              centroidVoxels: [4, 5, 6],
              covVoxels2: COVARIANCE,
            },
          ],
        },
      ],
    });
  });

  it("gives no results for an answer without any", () => {
    expect(
      parseGeometryInRadius(`{"resolution_nm":[1,1,1],"results":[]}`).results,
    ).toEqual([]);
  });
});

describe("pieceGeometryRequestBody", () => {
  it("asks for one piece of one root by exact decimal ids", () => {
    expect(
      JSON.parse(
        pieceGeometryRequestBody(
          72057594037927937n,
          144115188075855873n,
          [10, 20, 30],
          1000,
        ),
      ),
    ).toEqual({
      queries: [
        {
          root_id: "72057594037927937",
          piece_id: "144115188075855873",
          point_nm: [10, 20, 30],
          radius_nm: 1000,
        },
      ],
      limit: 1,
    });
  });
});

describe("parseGeometryInRadius for a piece query", () => {
  it("gives no pieces when the piece has no geometry or is not in the root", () => {
    const text = `{"resolution_nm":[4,4,40],"results":[{"root_id":72057594037927937,"pieces":[],"without_geometry":1,"truncated":false}]}`;
    expect(parseGeometryInRadius(text).results[0].pieces).toEqual([]);
  });
});
