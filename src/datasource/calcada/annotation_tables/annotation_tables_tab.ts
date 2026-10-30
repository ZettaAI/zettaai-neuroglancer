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

export class CalcadaAnnotationTablesTab extends Tab {
  constructor(connection: AnnotationTablesPanelConnection) {
    super();
    this.element.classList.add("calcada-annotations-tab");
    this.registerDisposer(
      mountComponent(this.element, CalcadaAnnotationTablesPanel, {
        connection,
      }),
    );
  }
}
