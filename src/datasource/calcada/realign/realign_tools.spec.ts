import { describe, expect, it, vi } from "vitest";
import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type { AxisAlignedBoundingBox } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import {
  boxSpanInAnnotationZ,
  RealignBoxTool,
  RealignCoordinates,
} from "#src/datasource/calcada/realign/realign_tools.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { PlaceBoundingBoxTool } from "#src/ui/annotations.js";

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

const identity = new RealignCoordinates(
  [0, 1, 2].map((annotationAxis) => ({ annotationAxis, scale: 1, offset: 0 })),
  GLOBAL_SCALES,
  RESOLUTION,
);

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

describe("RealignBoxTool", () => {
  // While the mouse moves, the box must keep the sections of the first click;
  // re-deriving them from its own lower edge slid the box down a section on
  // every move.
  it("keeps the sections of the first click while the mouse moves", () => {
    const click = (x: number, z: number) =>
      ({
        type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
        id: "",
        description: "",
        pointA: Float32Array.of(0, 0, 3104.5),
        pointB: Float32Array.of(x, x, z),
        properties: [],
      }) as AxisAlignedBoundingBox;
    vi.spyOn(
      PlaceBoundingBoxTool.prototype,
      "getInitialAnnotation",
    ).mockReturnValue(click(0, 3104.5));
    const update = vi.spyOn(
      PlaceBoundingBoxTool.prototype,
      "getUpdatedAnnotation",
    );
    const tool = new RealignBoxTool(
      {} as UserLayerWithAnnotations,
      {} as AnnotationLayerState,
      (z) => boxSpanInAnnotationZ(z, -1, identity),
    );
    const mouse = {} as MouseSelectionState;
    const layer = {} as AnnotationLayerState;

    let box = tool.getInitialAnnotation(mouse, layer) as AxisAlignedBoundingBox;
    for (const x of [10, 20, 30]) {
      update.mockReturnValue({
        ...box,
        pointB: Float32Array.of(x, x, box.pointB[2]),
      });
      box = tool.getUpdatedAnnotation(box, mouse, layer);
    }
    expect([box.pointA[2], box.pointB[2]]).toEqual([3103, 3105]);
  });
});
