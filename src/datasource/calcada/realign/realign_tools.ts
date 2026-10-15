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
 * @file The realign box and arrow tools. They place annotations in the
 * managed realign layer but are installed on the calcada segmentation layer,
 * so drawing never moves the selection off the layer whose Realign tab is
 * open.
 */

import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type {
  Annotation,
  AxisAlignedBoundingBox,
} from "#src/annotation/index.js";
import { sectionSpan } from "#src/datasource/calcada/realign/realign_selection.js";
import type { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import { PlaceBoundingBoxTool, PlaceLineTool } from "#src/ui/annotations.js";
import { registerLegacyTool } from "#src/ui/tool.js";

const Z = 2;
const METRES_PER_NANOMETRE = 1e-9;
// Saved with the segmentation layer, which hosts the tools, and restored as no
// tool: the realign annotation layer they draw into is not there yet on load.
const REALIGN_DRAW_TOOL_ID = "calcadaRealignDraw";
registerLegacyTool(REALIGN_DRAW_TOOL_ID, () => undefined);

/**
 * The global z range of the graph section under a global z.
 *
 * @param globalZ - z in global coordinates.
 * @param globalScaleZ - metres per global z unit.
 * @param resolutionZ - graph voxel z size in nanometres.
 */
export function globalSectionSpan(
  globalZ: number,
  globalScaleZ: number,
  resolutionZ: number,
): [number, number] {
  const toGlobal = (resolutionZ * METRES_PER_NANOMETRE) / globalScaleZ;
  const [lo, hi] = sectionSpan(globalZ / toGlobal);
  return [lo * toGlobal, hi * toGlobal];
}

/** A box one section thick, on the section of its first corner. */
export class RealignBoxTool extends PlaceBoundingBoxTool {
  constructor(
    layer: AnnotationUserLayer,
    private readonly spanOf: (globalZ: number) => [number, number],
  ) {
    super(layer, {});
  }

  getInitialAnnotation(
    mouseState: MouseSelectionState,
    annotationLayer: AnnotationLayerState,
  ): Annotation {
    return this.onFirstSection(
      super.getInitialAnnotation(
        mouseState,
        annotationLayer,
      ) as AxisAlignedBoundingBox,
    );
  }

  getUpdatedAnnotation(
    oldAnnotation: AxisAlignedBoundingBox,
    mouseState: MouseSelectionState,
    annotationLayer: AnnotationLayerState,
  ): AxisAlignedBoundingBox {
    return this.onFirstSection(
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

  private onFirstSection(box: AxisAlignedBoundingBox): AxisAlignedBoundingBox {
    const [lo, hi] = this.spanOf(box.pointA[Z]);
    const pointA = box.pointA.slice();
    const pointB = box.pointB.slice();
    pointA[Z] = lo;
    pointB[Z] = hi;
    return { ...box, pointA, pointB };
  }
}

export class RealignArrowTool extends PlaceLineTool {
  toJSON() {
    return REALIGN_DRAW_TOOL_ID;
  }
}
