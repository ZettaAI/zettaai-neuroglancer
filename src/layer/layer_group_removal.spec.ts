/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `layersDeletedByRemovingLayerGroup` against real `LayerManager`s: the root
 * manager, the group being removed and another group. The layers stand in for
 * `ManagedUserLayer` with what the managers use: signals, `containers`,
 * `archived`, the reference count and `manager.rootLayers`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { ManagedUserLayer } from "#src/layer/index.js";
import { LayerManager } from "#src/layer/index.js";
import { layersDeletedByRemovingLayerGroup } from "#src/layer/layer_group_removal.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

class ShownLayer extends RefCounted {
  readonly layerChanged = new NullarySignal();
  readonly readyStateChanged = new NullarySignal();
  readonly specificationChanged = new NullarySignal();
  readonly containers = new Set<LayerManager>();
  archived = false;

  constructor(
    readonly name: string,
    readonly manager: { readonly rootLayers: LayerManager },
  ) {
    super();
  }
}

let rootLayers: LayerManager;
let group: LayerManager;
let otherGroup: LayerManager;

beforeEach(() => {
  rootLayers = new LayerManager();
  group = new LayerManager();
  otherGroup = new LayerManager();
});

/** A layer in the root manager, also shown by each of `groups`. */
function addLayer(name: string, ...groups: LayerManager[]): ManagedUserLayer {
  const layer = new ShownLayer(name, {
    rootLayers,
  }) as unknown as ManagedUserLayer;
  rootLayers.addManagedLayer(layer);
  for (const shownBy of groups) shownBy.addManagedLayer(layer.addRef());
  return layer;
}

/** Let the root manager's debounced single-reference sweep run. */
function sweepRootLayers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("layersDeletedByRemovingLayerGroup", () => {
  it("is the layers only this group shows, in the group's order", () => {
    const first = addLayer("first", group);
    addLayer("shared", group, otherGroup);
    const second = addLayer("second", group);
    addLayer("elsewhere", otherGroup);

    expect(layersDeletedByRemovingLayerGroup(group)).toEqual([first, second]);
  });

  it("is empty when every layer of the group is shown elsewhere too", () => {
    addLayer("shared", group, otherGroup);
    expect(layersDeletedByRemovingLayerGroup(group)).toEqual([]);
  });

  it("leaves out archived layers", () => {
    const archived = addLayer("archived", group);
    archived.archived = true;
    expect(layersDeletedByRemovingLayerGroup(group)).toEqual([]);
  });

  it("is exactly what clearing the group deletes from the root manager", async () => {
    const only = addLayer("only", group);
    const shared = addLayer("shared", group, otherGroup);
    const archived = addLayer("archived", group);
    archived.archived = true;
    const elsewhere = addLayer("elsewhere", otherGroup);
    const predicted = layersDeletedByRemovingLayerGroup(group);

    group.clear();
    await sweepRootLayers();

    expect(predicted).toEqual([only]);
    expect(rootLayers.managedLayers).toEqual([shared, archived, elsewhere]);
    expect(only.wasDisposed).toBe(true);
  });
});
