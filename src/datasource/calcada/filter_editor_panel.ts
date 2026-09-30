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
 * @file The filter editor column: a viewer side panel, opened from the Trace
 * tab, placed where the trace state says.
 */

import type { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import type { FilterEditorProps } from "#src/datasource/calcada/react/filter_editor.js";
import { FilterEditor } from "#src/datasource/calcada/react/filter_editor.js";
import type { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import { ReactPanelMount } from "#src/editing/ui/interop/react/panel_mount.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import type { Disposer } from "#src/util/disposable.js";

export function registerFilterEditorPanel(
  manager: SidePanelManager,
  state: ZettaTraceState,
  library: FilterLibrary,
): Disposer {
  return manager.registerPanel({
    location: state.filterEditor,
    makePanel: () =>
      new ReactPanelMount<FilterEditorProps>(manager, state.filterEditor, {
        classNames: ["calcada-filter-editor-panel"],
        component: FilterEditor,
        props: { library, state },
      }),
  });
}
