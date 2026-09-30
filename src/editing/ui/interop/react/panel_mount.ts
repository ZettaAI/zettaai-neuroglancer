/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ComponentType } from "react";

import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";
import type { TrackableSidePanelLocation } from "#src/ui/side_panel_location.js";

export interface ReactPanelMountOptions<T extends object> {
  /** Omitted when the component draws its own header. */
  title?: string;
  classNames?: string[];
  component: ComponentType<T>;
  props: T;
}

/**
 * A side panel whose body is a React component. The component re-renders
 * itself from the signals it watches, so the panel mounts it once.
 */
export class ReactPanelMount<T extends object> extends SidePanel {
  constructor(
    sidePanelManager: SidePanelManager,
    location: TrackableSidePanelLocation,
    options: ReactPanelMountOptions<T>,
  ) {
    super(sidePanelManager, location);
    if (options.title !== undefined) this.addTitleBar({ title: options.title });
    const body = document.createElement("div");
    if (options.classNames) body.classList.add(...options.classNames);
    this.addBody(body);
    this.registerDisposer(
      mountComponent(body, options.component, options.props),
    );
  }
}
