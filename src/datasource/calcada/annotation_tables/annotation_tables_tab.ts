/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AnnotationTablesPanelConnection } from "#src/datasource/calcada/annotation_tables/annotation_tables_panel.js";
import { CalcadaAnnotationTablesPanel } from "#src/datasource/calcada/annotation_tables/annotation_tables_panel.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { Tab } from "#src/widget/tab_view.js";

export const ANNOTATION_TABLES_TAB_LABEL = "Tables";

/** The viewer's "select-previous" / "select-next" events, sent to the selected layer. */
const ADJACENT_ROW_EVENTS = [
  ["select-previous", -1],
  ["select-next", 1],
] as const;

export interface LayerEvents {
  registerLayerEvent(type: string, handler: () => void): () => boolean;
}

export class CalcadaAnnotationTablesTab extends Tab {
  constructor(connection: AnnotationTablesPanelConnection, layer: LayerEvents) {
    super();
    this.element.classList.add("calcada-annotations-tab");
    this.registerDisposer(
      mountComponent(this.element, CalcadaAnnotationTablesPanel, {
        connection,
      }),
    );
    for (const [event, offset] of ADJACENT_ROW_EVENTS) {
      this.registerDisposer(
        layer.registerLayerEvent(event, () => {
          if (this.visible) {
            connection.annotationTablesSession.selectAdjacent(offset);
          }
        }),
      );
    }
  }
}
