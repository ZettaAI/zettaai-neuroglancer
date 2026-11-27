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
 * @file The layer's "Realign" tab — the mount seam between neuroglancer's Tab
 * and the React panel.
 */

import type { RealignPanelSession } from "#src/datasource/calcada/react/realign_panel.js";
import { RealignPanel } from "#src/datasource/calcada/react/realign_panel.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { Tab } from "#src/widget/tab_view.js";

export class CalcadaRealignTab extends Tab {
  constructor(session: RealignPanelSession) {
    super();
    this.element.classList.add("calcada-realign-tab");
    this.registerDisposer(
      mountComponent(this.element, RealignPanel, { session }),
    );
  }
}
