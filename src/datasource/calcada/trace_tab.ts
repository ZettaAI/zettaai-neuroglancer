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
 * @file The layer's "Trace" tab — the mount seam between neuroglancer's Tab
 * and the React panel.
 *
 * Unlike the Debug tab beside it, this one is never hidden: the trace is
 * started from here now, so a tab that only appeared once the mode was on
 * would have nowhere to start it from.
 */

import type { TracePanelConnection } from "#src/datasource/calcada/react/trace_panel.js";
import { CalcadaTracePanel } from "#src/datasource/calcada/react/trace_panel.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { Tab } from "#src/widget/tab_view.js";

export class CalcadaTraceTab extends Tab {
  constructor(connection: TracePanelConnection) {
    super();
    this.element.classList.add("calcada-trace-tab");
    this.registerDisposer(
      mountComponent(this.element, CalcadaTracePanel, { connection }),
    );
  }
}
