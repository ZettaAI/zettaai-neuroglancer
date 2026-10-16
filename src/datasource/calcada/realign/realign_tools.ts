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
import { sectionSpan } from "#src/datasource/calcada/realign/realign_selection.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { PlaceBoundingBoxTool, PlaceLineTool } from "#src/ui/annotations.js";
import { registerLegacyTool } from "#src/ui/tool.js";

const Z = 2;
// Saved with the segmentation layer, which hosts the tools, and restored as no
// tool: a realign session arms them again when it needs them.
const REALIGN_DRAW_TOOL_ID = "calcadaRealignDraw";
registerLegacyTool(REALIGN_DRAW_TOOL_ID, () => undefined);

/**
 * The z range, in annotation units, of a realign box drawn at an annotation z:
 * the graph section under it, the reference section and every section
 * between.
 *
 * @param z - z in annotation coordinate units.
 * @param nanometresPerUnitZ - nanometres per annotation z unit.
 * @param resolutionZ - graph voxel z size in nanometres.
 * @param referenceOffset - the reference section's offset from the drawn one.
 */
export function boxSpanInUnits(
  z: number,
  nanometresPerUnitZ: number,
  resolutionZ: number,
  referenceOffset: number,
): [number, number] {
  const unitsPerVoxel = resolutionZ / nanometresPerUnitZ;
  const [section] = sectionSpan(z / unitsPerVoxel);
  const reference = section + referenceOffset;
  return [
    Math.min(section, reference) * unitsPerVoxel,
    (Math.max(section, reference) + 1) * unitsPerVoxel,
  ];
}

/** A box over the section of its first corner and the reference section. */
export class RealignBoxTool extends PlaceBoundingBoxTool {
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
    return this.onBoxSections(
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
    const [lo, hi] = this.spanOf(box.pointA[Z]);
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
