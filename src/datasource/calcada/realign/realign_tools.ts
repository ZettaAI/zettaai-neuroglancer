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
 * @file The realign box and arrow tools: installed on the calcada
 * segmentation layer and drawing into that layer's own realign annotations,
 * so drawing never adds or selects another layer.
 */

import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type {
  Annotation,
  AxisAlignedBoundingBox,
} from "#src/annotation/index.js";
import { sectionOf } from "#src/datasource/calcada/realign/realign_selection.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { PlaceBoundingBoxTool, PlaceLineTool } from "#src/ui/annotations.js";
import { registerLegacyTool } from "#src/ui/tool.js";

const Z = 2;
// Saved with the segmentation layer, which hosts the tools, and restored as no
// tool: a realign session arms them again when it needs them.
const REALIGN_DRAW_TOOL_ID = "calcadaRealignDraw";
registerLegacyTool(REALIGN_DRAW_TOOL_ID, () => undefined);

const METRES_PER_NANOMETRE = 1e-9;
const GLOBAL_AXES = 3;

/** One global axis as an affine function of one annotation axis. */
interface AxisMapping {
  readonly annotationAxis: number;
  readonly scale: number;
  readonly offset: number;
}

/**
 * Converts between a layer's annotation coordinates, global coordinates and
 * graph voxels. Annotation coordinates are the layer's source coordinates,
 * which the layer's transform may shift or scale against global ones.
 */
export class RealignCoordinates {
  constructor(
    private readonly axes: readonly AxisMapping[],
    private readonly globalScales: ArrayLike<number>,
    private readonly resolution: ArrayLike<number>,
  ) {}

  /**
   * @param transform - the annotation state's render layer transform; assumed
   *   axis-aligned, as calcada sources are.
   * @param globalScales - metres per global unit, per axis.
   * @param resolution - graph voxel size in nanometres, per axis.
   */
  static fromTransform(
    transform: RenderLayerTransform,
    globalScales: ArrayLike<number>,
    resolution: ArrayLike<number>,
  ): RealignCoordinates {
    const { rank, modelToRenderLayerTransform: matrix } = transform;
    const stride = rank + 1;
    const axes = Array.from({ length: GLOBAL_AXES }, (_, globalAxis) => {
      const renderAxis = transform.globalToRenderLayerDimensions[globalAxis];
      let annotationAxis = 0;
      for (let axis = 1; axis < rank; ++axis) {
        if (
          Math.abs(matrix[axis * stride + renderAxis]) >
          Math.abs(matrix[annotationAxis * stride + renderAxis])
        ) {
          annotationAxis = axis;
        }
      }
      return {
        annotationAxis,
        scale: matrix[annotationAxis * stride + renderAxis],
        offset: matrix[rank * stride + renderAxis],
      };
    });
    return new RealignCoordinates(axes, globalScales, resolution);
  }

  toGlobal(point: ArrayLike<number>): number[] {
    return this.axes.map(
      ({ annotationAxis, scale, offset }) =>
        scale * point[annotationAxis] + offset,
    );
  }

  toGraphVoxels(point: ArrayLike<number>): number[] {
    return this.toGlobal(point).map((value, axis) =>
      this.globalToGraphVoxel(value, axis),
    );
  }

  annotationZToGraphVoxelZ(z: number): number {
    const { scale, offset } = this.axes[Z];
    return this.globalToGraphVoxel(scale * z + offset, Z);
  }

  graphVoxelZToAnnotationZ(voxelZ: number): number {
    const { scale, offset } = this.axes[Z];
    const globalZ =
      (voxelZ * this.resolution[Z] * METRES_PER_NANOMETRE) /
      this.globalScales[Z];
    return (globalZ - offset) / scale;
  }

  private globalToGraphVoxel(value: number, axis: number): number {
    return (
      (value * this.globalScales[axis]) /
      METRES_PER_NANOMETRE /
      this.resolution[axis]
    );
  }
}

/**
 * The annotation z range of a realign box drawn at annotation z: the graph
 * section under it, the reference section and every section between.
 */
export function boxSpanInAnnotationZ(
  z: number,
  referenceOffset: number,
  coordinates: RealignCoordinates,
): [number, number] {
  const section = sectionOf(coordinates.annotationZToGraphVoxelZ(z));
  const reference = section + referenceOffset;
  const ends = [
    coordinates.graphVoxelZToAnnotationZ(Math.min(section, reference)),
    coordinates.graphVoxelZToAnnotationZ(Math.max(section, reference) + 1),
  ];
  return [Math.min(...ends), Math.max(...ends)];
}

/** A box over the section of its first corner and the reference section. */
export class RealignBoxTool extends PlaceBoundingBoxTool {
  // Taken once from the first click: re-deriving it from the box's own lower
  // edge on every mouse move would slide the box down a section each time.
  private span: [number, number] | undefined;

  constructor(
    layer: UserLayerWithAnnotations,
    private readonly annotations: AnnotationLayerState,
    private readonly spanOf: (z: number) => [number, number],
  ) {
    super(layer, {});
  }

  get annotationLayer() {
    return this.annotations;
  }

  getInitialAnnotation(
    mouseState: MouseSelectionState,
    annotationLayer: AnnotationLayerState,
  ): Annotation {
    const box = super.getInitialAnnotation(
      mouseState,
      annotationLayer,
    ) as AxisAlignedBoundingBox;
    this.span = this.spanOf(box.pointA[Z]);
    return this.onBoxSections(box);
  }

  getUpdatedAnnotation(
    oldAnnotation: AxisAlignedBoundingBox,
    mouseState: MouseSelectionState,
    annotationLayer: AnnotationLayerState,
  ): AxisAlignedBoundingBox {
    return this.onBoxSections(
      super.getUpdatedAnnotation(
        oldAnnotation,
        mouseState,
        annotationLayer,
      ) as AxisAlignedBoundingBox,
    );
  }

  toJSON() {
    return REALIGN_DRAW_TOOL_ID;
  }

  private onBoxSections(box: AxisAlignedBoundingBox): AxisAlignedBoundingBox {
    const [lo, hi] = this.span ?? this.spanOf(box.pointA[Z]);
    const pointA = box.pointA.slice();
    const pointB = box.pointB.slice();
    pointA[Z] = lo;
    pointB[Z] = hi;
    return { ...box, pointA, pointB };
  }
}

export class RealignArrowTool extends PlaceLineTool {
  constructor(
    layer: UserLayerWithAnnotations,
    private readonly annotations: AnnotationLayerState,
  ) {
    super(layer, {});
  }

  get annotationLayer() {
    return this.annotations;
  }

  toJSON() {
    return REALIGN_DRAW_TOOL_ID;
  }
}
