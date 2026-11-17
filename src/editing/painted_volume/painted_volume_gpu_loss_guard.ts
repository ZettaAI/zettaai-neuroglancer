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
 * @file Keeps the 3D preview off in a tab whose GPU was lost while it ran.
 *
 * On a weak GPU a frame can take long enough for the system to reset the GPU;
 * the viewer then loses its WebGL context. Neuroglancer reloads the page once
 * the context is restored, the session opens again with the same layout, and
 * the same frame can reset the GPU again — after a few resets the browser
 * blocks WebGL for the site.
 *
 * So a context lost while a preview exists is remembered in `sessionStorage`
 * (it survives that reload, and stays with the tab), and no preview is built
 * in that tab again. A new tab starts with the preview on.
 */

import type { Logger } from "@zettaai/edit-session";

import { RefCounted } from "#src/util/disposable.js";

export const PAINTED_VOLUME_GPU_LOSS_KEY =
  "zetta-painted-volume-preview-off-after-gpu-loss";

/** The `Storage` calls the guard makes. */
export type PaintedVolumeGpuLossStorage = Pick<Storage, "getItem" | "setItem">;

export interface PaintedVolumeGpuLossGuardOptions {
  /** The viewer's WebGL canvas. */
  readonly canvas: EventTarget;
  /** `sessionStorage`, or `undefined` where it cannot be reached. */
  readonly storage: PaintedVolumeGpuLossStorage | undefined;
  readonly logger: Logger;
  /** True while at least one preview exists. */
  previewExists(): boolean;
}

export class PaintedVolumeGpuLossGuard extends RefCounted {
  /** Also covers storage that throws or is missing: then only this page remembers. */
  private lostThisPage = false;
  private reportedOff = false;

  constructor(private readonly options: PaintedVolumeGpuLossGuardOptions) {
    super();
    const onContextLost = () => this.onContextLost();
    options.canvas.addEventListener("webglcontextlost", onContextLost);
    this.registerDisposer(() =>
      options.canvas.removeEventListener("webglcontextlost", onContextLost),
    );
  }

  /** False once a GPU was lost under a preview in this tab. */
  previewAllowed(): boolean {
    const allowed = !this.lostThisPage && !this.rememberedLoss();
    if (!allowed && !this.reportedOff) {
      this.reportedOff = true;
      this.options.logger.warn(
        "editing",
        "3D preview: off in this tab, the GPU was lost while it ran; a new tab turns it on again",
      );
    }
    return allowed;
  }

  private onContextLost(): void {
    if (!this.options.previewExists()) return;
    this.lostThisPage = true;
    try {
      this.options.storage?.setItem(PAINTED_VOLUME_GPU_LOSS_KEY, "1");
    } catch {
      // Storage refused: this page still remembers, the reload will not.
    }
    this.options.logger.warn(
      "editing",
      "3D preview: the WebGL context was lost while the preview ran; turning it off in this tab",
    );
  }

  private rememberedLoss(): boolean {
    try {
      return this.options.storage?.getItem(PAINTED_VOLUME_GPU_LOSS_KEY) === "1";
    } catch {
      return false;
    }
  }
}

/** `sessionStorage`, or `undefined` where reaching it throws (sandboxed frames). */
export function reachableSessionStorage():
  | PaintedVolumeGpuLossStorage
  | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}
