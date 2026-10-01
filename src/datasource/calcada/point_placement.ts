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
 * @file A mode for dropping a point: while it is on, 2D views show a target
 * cursor and 3D views a cross (a point is placed in 2D only), a notice over
 * the views says what to do, and Escape leaves the mode.
 */

import { PointPlacementNotice } from "#src/datasource/calcada/react/point_placement_notice.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { PerspectivePanel } from "#src/perspective_view/panel.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer, RefCounted } from "#src/util/disposable.js";

export type PanelKind = "2d" | "3d";

export interface PointPlacementRequest {
  /** What to click, in the user's words. */
  message: string;
  /** Escape was pressed: the mode has ended without a point. */
  onCancel: () => void;
}

export interface PlacementDisplay {
  container: HTMLElement;
  panels: Iterable<{ element: HTMLElement }>;
  updateFinished: { add(listener: () => void): () => void };
}

const PANEL_CLASSES: Record<PanelKind, string> = {
  "2d": "calcada-placing-point-2d",
  "3d": "calcada-placing-point-3d",
};

export function viewerPanelKind(panel: object): PanelKind | undefined {
  if (panel instanceof SliceViewPanel) return "2d";
  if (panel instanceof PerspectivePanel) return "3d";
  return undefined;
}

export class PointPlacement extends RefCounted {
  private request: PointPlacementRequest | undefined;
  private readonly notice = document.createElement("div");
  private unmountNotice: Disposer | undefined;
  private marked = new Set<HTMLElement>();

  constructor(
    private readonly display: PlacementDisplay,
    private readonly kindOf: (panel: object) => PanelKind | undefined,
  ) {
    super();
    this.notice.className = "calcada-point-placement-notice";
    // Views come and go with the layout; a new one is marked as it draws.
    this.registerDisposer(
      display.updateFinished.add(() => {
        if (this.request !== undefined) this.markPanels();
      }),
    );
    this.registerEventListener(document, "keydown", this.onKeyDown, true);
    this.registerDisposer(() => this.end());
  }

  get active(): boolean {
    return this.request !== undefined;
  }

  begin(request: PointPlacementRequest) {
    this.request = request;
    this.markPanels();
    if (this.unmountNotice !== undefined) invokeDisposer(this.unmountNotice);
    this.display.container.appendChild(this.notice);
    this.unmountNotice = mountComponent(this.notice, PointPlacementNotice, {
      message: request.message,
    });
  }

  end() {
    if (this.request === undefined) return;
    this.request = undefined;
    for (const element of this.marked) {
      element.classList.remove(...Object.values(PANEL_CLASSES));
    }
    this.marked.clear();
    if (this.unmountNotice !== undefined) invokeDisposer(this.unmountNotice);
    this.unmountNotice = undefined;
    this.notice.remove();
  }

  private markPanels() {
    for (const panel of this.display.panels) {
      const kind = this.kindOf(panel);
      if (kind === undefined) continue;
      panel.element.classList.add(PANEL_CLASSES[kind]);
      this.marked.add(panel.element);
    }
  }

  // Captured, so the views' own Escape (leaving the trace) does not also run.
  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || this.request === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const { onCancel } = this.request;
    this.end();
    onCancel();
  };
}
