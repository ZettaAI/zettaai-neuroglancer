/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { ToolPanelKeys } from "#src/editing/ui/tool_settings/tool_panel_keys.js";

export function Correspondence({ host }: { host: EditSessionHost }) {
  return (
    <div class="neuroglancer-tool-panel neuroglancer-correspondence-panel">
      <p class="neuroglancer-tool-panel-placeholder">
        Correspondence tool is not available in v1.
      </p>
      <div class="neuroglancer-tool-panel-row">
        <button type="button" disabled>
          Auto-detect
        </button>
        <button type="button" disabled>
          Apply warp
        </button>
      </div>
      <ToolPanelKeys host={host} toolId="correspondence" />
    </div>
  );
}
