/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { layerId, sessionId } from "@zettaai/edit-session";

import { NgSessionLockAdapter } from "#src/editing/adapters/ng_session_lock.js";
import type {
  LayerManager,
  ManagedUserLayer,
  TopLevelLayerListSpecification,
} from "#src/layer/index.js";
import { NullarySignal } from "#src/util/signal.js";

/**
 * Minimal stand-in for the viewer's `TopLevelLayerListSpecification` with an
 * `EditSessionHost` published on it, for upstream layer UI that consults the
 * session lock through `root.editSessionHost`. The host carries a real
 * `NgSessionLockAdapter`; nothing else of the host is faked, so a widget that
 * reaches for more fails loudly.
 */
export class FakeLayerRoot {
  readonly sessionLock = new NgSessionLockAdapter();
  readonly layers: ManagedUserLayer[] = [];
  readonly rootLayers = {
    managedLayers: this.layers,
    layersChanged: new NullarySignal(),
    getUniqueLayerName: (name: string) => {
      let candidate = name;
      let suffix = 0;
      while (this.layers.some((layer) => layer.name === candidate)) {
        candidate = name + ++suffix;
      }
      return candidate;
    },
  } as unknown as LayerManager;
  readonly root = {
    editSessionHost: { sessionLock: this.sessionLock },
    layerManager: this.rootLayers,
  } as unknown as TopLevelLayerListSpecification;

  /**
   * A managed layer shown only by the root manager, exposing what the layer UI
   * reads: its name, `layerChanged`, `manager.root` and `containers`.
   */
  addLayer(name: string): ManagedUserLayer {
    const layer = {
      name,
      layer: null,
      layerChanged: new NullarySignal(),
      manager: { root: this.root, rootLayers: this.rootLayers },
      containers: new Set<LayerManager>([this.rootLayers]),
    } as unknown as ManagedUserLayer;
    this.layers.push(layer);
    return layer;
  }

  /** Publish an active session over `layerNames`, as `openSession` does. */
  openSession(...layerNames: string[]): void {
    this.sessionLock.setActiveSession({
      sessionId: sessionId("session"),
      sessionLayerIds: new Set(layerNames.map((name) => layerId(name))),
    });
  }

  /** End the session, as session teardown does. */
  closeSession(): void {
    this.sessionLock.clearActiveSession();
  }

  /**
   * Start restoring a session over `layerNames` from the URL's intent, as
   * `tryRestoreFromState` does before the session opens.
   */
  startRestore(...layerNames: string[]): void {
    this.sessionLock.restoringLayerIds.value = new Set(
      layerNames.map((name) => layerId(name)),
    );
  }

  /** End the restore attempt, whether it opened the session or failed. */
  endRestore(): void {
    this.sessionLock.restoringLayerIds.value = undefined;
  }
}
