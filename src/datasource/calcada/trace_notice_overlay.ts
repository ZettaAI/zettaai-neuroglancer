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
 * @file The mount seam for the trace banner. It lives in the display container,
 * which also runs under the side panels, so it is placed against the data
 * panels' own top-right corner: opening the settings sidebar shifts it left
 * instead of hiding it underneath.
 */

import type { TraceNoticeSource } from "#src/datasource/calcada/react/trace_notice.js";
import { CalcadaTraceNotice } from "#src/datasource/calcada/react/trace_notice.js";
import type { DisplayContext } from "#src/display_context.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer, RefCounted } from "#src/util/disposable.js";

const NOTICE_MARGIN_TOP_PX = 72;
const NOTICE_MARGIN_RIGHT_PX = 56;

export class TraceNoticeOverlay extends RefCounted {
  private readonly element = document.createElement("div");
  private unmount: Disposer | undefined;
  private placedForGeneration = -1;

  constructor(
    private readonly display: DisplayContext,
    private readonly source: TraceNoticeSource,
  ) {
    super();
    this.element.className = "calcada-trace-notice-overlay";
    this.registerDisposer(source.active.changed.add(() => this.update()));
    this.registerDisposer(source.sphereCenter.changed.add(() => this.update()));
    this.registerDisposer(display.updateFinished.add(() => this.place()));
    this.registerDisposer(() => this.hide());
    this.update();
  }

  // Before the sphere is down there is no queue to report on.
  private update() {
    const { active, sphereCenter } = this.source;
    if (active.value && sphereCenter.value !== undefined) {
      this.show();
    } else {
      this.hide();
    }
  }

  private show() {
    if (this.unmount !== undefined) return;
    this.display.container.appendChild(this.element);
    this.unmount = mountComponent(this.element, CalcadaTraceNotice, {
      source: this.source,
    });
    this.placedForGeneration = -1;
    this.place();
  }

  private hide() {
    if (this.unmount !== undefined) invokeDisposer(this.unmount);
    this.unmount = undefined;
    this.element.remove();
  }

  private place() {
    if (this.unmount === undefined) return;
    const { resizeGeneration } = this.display;
    if (resizeGeneration === this.placedForGeneration) return;
    const panelsRect = this.dataPanelsRect();
    if (panelsRect === undefined) return;
    this.placedForGeneration = resizeGeneration;
    const containerRect = this.display.container.getBoundingClientRect();
    const { style } = this.element;
    style.top = `${panelsRect.top - containerRect.top + NOTICE_MARGIN_TOP_PX}px`;
    style.right = `${containerRect.right - panelsRect.right + NOTICE_MARGIN_RIGHT_PX}px`;
  }

  private dataPanelsRect(): { top: number; right: number } | undefined {
    let top = Infinity;
    let right = -Infinity;
    for (const panel of this.display.panels) {
      if (!(panel instanceof RenderedDataPanel) || !panel.visible) continue;
      const rect = panel.element.getBoundingClientRect();
      if (rect.width === 0) continue;
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
    }
    return Number.isFinite(top) ? { top, right } : undefined;
  }
}
