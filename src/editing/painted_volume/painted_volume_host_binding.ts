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
 * @file Ties painted-volume previews to the edit-session host (plan §3.9, §8.2).
 *
 * One preview per writable session layer, alive while the toggle is on and the
 * session is open. The host keeps only calls into this binding at its
 * lifecycle points (open, teardown, reset, datasource reload); the reactions —
 * the toggle, attaching the render layer to its segmentation layer, and
 * re-attaching when that layer is removed and added again — live here.
 *
 * The binding talks to the host through `PaintedVolumeHostPort` only, so it
 * can be specified with fakes.
 */

import type { LayerId } from "@zettaai/edit-session";

import type { PaintedVolumePreview } from "#src/editing/painted_volume/painted_volume_preview.js";
import type { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import type { NullarySignal } from "#src/util/signal.js";

/** What the binding uses of a preview. */
export type PaintedVolumeBoundPreview = Pick<
  PaintedVolumePreview,
  "status" | "renderLayer" | "onDatasourceRefetched" | "dispose"
>;

/** `UserLayer.addRenderLayer`: takes a reference; the disposer releases it. */
export interface PaintedVolumeUserLayer {
  addRenderLayer(layer: PerspectiveViewRenderLayer): () => void;
}

export interface PaintedVolumeHostPort {
  readonly enabled: WatchableValueInterface<boolean>;
  /** The layer manager's `layersChanged`; read only once a preview exists. */
  readonly layersChanged: NullarySignal;
  /** Writable layers of the open session that have patch machinery. */
  sessionLayerIds(): Iterable<LayerId>;
  findUserLayer(layerId: LayerId): PaintedVolumeUserLayer | undefined;
  /** `undefined` while the host cannot build one yet (tools still wiring). */
  createPreview(layerId: LayerId): PaintedVolumeBoundPreview | undefined;
}

interface BoundPreview {
  readonly preview: PaintedVolumeBoundPreview;
  userLayer: PaintedVolumeUserLayer | undefined;
  detach: (() => void) | undefined;
}

export class PaintedVolumeHostBinding extends RefCounted {
  private readonly bound = new Map<LayerId, BoundPreview>();
  /** `addRenderLayer` and its disposer both dispatch `layersChanged`. */
  private reattaching = false;
  /** Listening only while something is bound; nothing to re-attach otherwise. */
  private stopWatchingLayers: (() => void) | undefined;

  constructor(private readonly port: PaintedVolumeHostPort) {
    super();
    this.registerDisposer(port.enabled.changed.add(() => this.sync()));
    this.registerDisposer(() => this.releaseAll());
  }

  previewFor(layerId: LayerId): PaintedVolumeBoundPreview | undefined {
    return this.bound.get(layerId)?.preview;
  }

  /**
   * Bring the previews in line with the toggle and the session: create what is
   * missing, drop what no longer belongs. Safe to call at any time.
   */
  sync(): void {
    if (!this.port.enabled.value) {
      this.releaseAll();
      return;
    }
    const sessionLayerIds = new Set(this.port.sessionLayerIds());
    for (const layerId of this.bound.keys()) {
      if (!sessionLayerIds.has(layerId)) this.release(layerId);
    }
    for (const layerId of sessionLayerIds) {
      if (this.bound.has(layerId)) continue;
      const preview = this.port.createPreview(layerId);
      if (preview === undefined) continue;
      const entry: BoundPreview = {
        preview,
        userLayer: undefined,
        detach: undefined,
      };
      this.bound.set(layerId, entry);
      this.attach(layerId, entry);
    }
    if (this.bound.size > 0) this.watchLayers();
  }

  /** Detach and dispose `layerId`'s preview; the next `sync` builds a new one. */
  release(layerId: LayerId): void {
    const entry = this.bound.get(layerId);
    if (entry === undefined) return;
    this.bound.delete(layerId);
    this.detach(entry);
    entry.preview.dispose();
    if (this.bound.size === 0) this.unwatchLayers();
  }

  releaseAll(): void {
    for (const layerId of this.bound.keys()) this.release(layerId);
  }

  onDatasourceRefetched(): void {
    for (const { preview } of this.bound.values()) {
      preview.onDatasourceRefetched();
    }
  }

  private watchLayers(): void {
    this.stopWatchingLayers ??= this.port.layersChanged.add(() =>
      this.reattachAll(),
    );
  }

  private unwatchLayers(): void {
    this.stopWatchingLayers?.();
    this.stopWatchingLayers = undefined;
  }

  private reattachAll(): void {
    if (this.reattaching) return;
    for (const [layerId, entry] of this.bound) this.attach(layerId, entry);
  }

  /** Attach to the layer's current `UserLayer`, moving off a replaced one. */
  private attach(layerId: LayerId, entry: BoundPreview): void {
    const renderLayer = entry.preview.renderLayer;
    if (renderLayer === undefined) return;
    const userLayer = this.port.findUserLayer(layerId);
    if (userLayer === entry.userLayer) return;
    this.detach(entry);
    if (userLayer === undefined) return;
    this.whileReattaching(() => {
      entry.detach = userLayer.addRenderLayer(renderLayer.addRef());
      entry.userLayer = userLayer;
    });
  }

  private detach(entry: BoundPreview): void {
    const { detach } = entry;
    entry.detach = undefined;
    entry.userLayer = undefined;
    if (detach !== undefined) this.whileReattaching(detach);
  }

  private whileReattaching(action: () => void): void {
    const wasReattaching = this.reattaching;
    this.reattaching = true;
    try {
      action();
    } finally {
      this.reattaching = wasReattaching;
    }
  }
}
