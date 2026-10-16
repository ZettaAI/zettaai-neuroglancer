import { describe, expect, it } from "vitest";
import {
  boxSpanInAnnotationZ,
  RealignCoordinates,
} from "#src/datasource/calcada/realign/realign_tools.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";

const NANOMETRE = 1e-9;
const GLOBAL_SCALES = [16 * NANOMETRE, 16 * NANOMETRE, 45 * NANOMETRE];
const RESOLUTION = [16, 16, 45];
// The layer's source sits 456 sections lower than the global space.
const Z_TRANSLATION = 456;

function translatedTransform(): RenderLayerTransform {
  const rank = 3;
  const matrix = new Float32Array((rank + 1) * (rank + 1));
  for (let axis = 0; axis <= rank; ++axis) matrix[axis * (rank + 1) + axis] = 1;
  matrix[rank * (rank + 1) + 2] = Z_TRANSLATION;
  return {
    rank,
    unpaddedRank: rank,
    globalToRenderLayerDimensions: [0, 1, 2],
    modelToRenderLayerTransform: matrix,
  } as unknown as RenderLayerTransform;
}

const coordinates = RealignCoordinates.fromTransform(
  translatedTransform(),
  GLOBAL_SCALES,
  RESOLUTION,
);

describe("RealignCoordinates", () => {
  it("reads annotation points as global, then graph voxels", () => {
    expect(coordinates.toGlobal([10, 20, 2648.5])).toEqual([10, 20, 3104.5]);
    expect(coordinates.toGraphVoxels([10, 20, 2648.5])).toEqual([
      10, 20, 3104.5,
    ]);
  });

  it("turns a graph section back into annotation z", () => {
    expect(coordinates.graphVoxelZToAnnotationZ(3104)).toBe(2648);
  });
});

describe("boxSpanInAnnotationZ", () => {
  it("covers the clicked section and the one below it", () => {
    expect(boxSpanInAnnotationZ(2648.5, -1, coordinates)).toEqual([2647, 2649]);
  });

  it("reaches up to a reference above, sections between included", () => {
    const [lo, hi] = boxSpanInAnnotationZ(2648.5, 2, coordinates);
    expect(lo).toBeCloseTo(2648);
    expect(hi).toBeCloseTo(2651);
  });
});
