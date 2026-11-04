/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { PlaceLineTool, PlacePointTool } from "#src/ui/annotations.js";
import type { LegacyTool } from "#src/ui/tool.js";

const TABLE_POINT_DESCRIPTION = "add point to table";
const TABLE_LINE_DESCRIPTION = "add line to table";

function writable(state: AnnotationLayerState) {
  return state.source.readonly ? undefined : state;
}

// Neither tool goes into the layer's JSON: after a reload its table is not
// drawn yet, and arming happens from the Tables tab.

export class TablePointTool extends PlacePointTool {
  constructor(
    layer: UserLayerWithAnnotations,
    readonly tableState: AnnotationLayerState,
  ) {
    super(layer, {});
  }

  get annotationLayer() {
    return writable(this.tableState);
  }

  get description() {
    return TABLE_POINT_DESCRIPTION;
  }

  toJSON(): any {
    return undefined;
  }
}

export class TableLineTool extends PlaceLineTool {
  constructor(
    layer: UserLayerWithAnnotations,
    readonly tableState: AnnotationLayerState,
  ) {
    super(layer, {});
    // The second click would otherwise pick the line being drawn.
    const { disablePicking } = tableState.displayState;
    this.registerDisposer(
      this.inProgressAnnotation.changed.add(() => {
        disablePicking.value = this.inProgressAnnotation.value !== undefined;
      }),
    );
  }

  get annotationLayer() {
    return writable(this.tableState);
  }

  get description() {
    return TABLE_LINE_DESCRIPTION;
  }

  toJSON(): any {
    return undefined;
  }
}

/** The table state the tool adds to, when it is one of these. */
export function tableStateOfTool(
  tool: LegacyTool | undefined,
): AnnotationLayerState | undefined {
  return tool instanceof TablePointTool || tool instanceof TableLineTool
    ? tool.tableState
    : undefined;
}
