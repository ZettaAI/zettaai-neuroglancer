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
 * The bridge upstream layer UI uses to lock session layers against deletes,
 * renames, type changes and subsource toggles. Driven through a real
 * `NgSessionLockAdapter` published on a fake layer root, the way the viewer
 * publishes the host.
 */

import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindSessionLayerDeleteIcon,
  isSessionLayer,
  layerGroupHoldsOnlyCopyOfSessionLayer,
  observeSessionLayerLock,
  SESSION_LAYER_LOCK_REASON,
  showSessionLayerLockOnIcon,
} from "#src/editing/adapters/session_layer_structure_lock.js";
import type {
  LayerManager,
  ManagedUserLayer,
  TopLevelLayerListSpecification,
} from "#src/layer/index.js";
import { confirmLayerDeletion } from "#src/ui/layer_deletion_confirmation.js";
import { NullarySignal } from "#src/util/signal.js";

import { FakeLayerRoot } from "#tests/editing/fakes/fake_layer_root.js";

describe("isSessionLayer", () => {
  let layers: FakeLayerRoot;

  beforeEach(() => {
    layers = new FakeLayerRoot();
  });

  it("follows the active session's layers by name", () => {
    const writable = layers.addLayer("writable");
    const reference = layers.addLayer("reference");
    const outsider = layers.addLayer("outsider");
    expect(isSessionLayer(writable)).toBe(false);

    layers.openSession("writable", "reference");

    expect(isSessionLayer(writable)).toBe(true);
    expect(isSessionLayer(reference)).toBe(true);
    expect(isSessionLayer(outsider)).toBe(false);

    layers.closeSession();

    expect(isSessionLayer(writable)).toBe(false);
    expect(isSessionLayer(reference)).toBe(false);
  });

  it("covers the layers of a session being restored", () => {
    const writable = layers.addLayer("writable");
    const outsider = layers.addLayer("outsider");

    layers.startRestore("writable");

    expect(isSessionLayer(writable)).toBe(true);
    expect(isSessionLayer(outsider)).toBe(false);

    layers.endRestore();

    expect(isSessionLayer(writable)).toBe(false);
  });

  it("locks nothing when no edit-session host is wired", () => {
    const layer = {
      name: "writable",
      layerChanged: new NullarySignal(),
      manager: {
        root: {
          editSessionHost: undefined,
        } as unknown as TopLevelLayerListSpecification,
      },
    } as unknown as ManagedUserLayer;

    expect(isSessionLayer(layer)).toBe(false);
    const applied: boolean[] = [];
    const dispose = observeSessionLayerLock(layer, (locked) =>
      applied.push(locked),
    );
    layer.layerChanged.dispatch();
    dispose();
    expect(applied).toEqual([false]);
  });
});

describe("observeSessionLayerLock", () => {
  let layers: FakeLayerRoot;
  let layer: ManagedUserLayer;
  let applied: boolean[];

  beforeEach(() => {
    layers = new FakeLayerRoot();
    layer = layers.addLayer("writable");
    applied = [];
  });

  function observe() {
    return observeSessionLayerLock(layer, (locked) => applied.push(locked));
  }

  it("applies the current state right away", () => {
    layers.openSession("writable");
    observe();
    expect(applied).toEqual([true]);
  });

  it("re-applies when a session opens and when it closes", () => {
    observe();
    layers.openSession("writable");
    layers.closeSession();
    expect(applied).toEqual([false, true, false]);
  });

  it("re-applies when a restore starts and when it fails", () => {
    observe();
    layers.startRestore("writable");
    layers.endRestore();
    expect(applied).toEqual([false, true, false]);
  });

  it("stays locked when a restore opens the session", () => {
    observe();
    layers.startRestore("writable");
    layers.openSession("writable");
    layers.endRestore();
    expect(applied).toEqual([false, true]);
  });

  it("does not re-apply when the lock does not flip", () => {
    observe();
    layers.openSession("another-layer");
    layer.layerChanged.dispatch();
    expect(applied).toEqual([false]);
  });

  it("re-applies when the layer is renamed into or out of the session", () => {
    layers.openSession("writable");
    observe();
    (layer as { name: string }).name = "renamed";
    layer.layerChanged.dispatch();
    (layer as { name: string }).name = "writable";
    layer.layerChanged.dispatch();
    expect(applied).toEqual([true, false, true]);
  });

  it("stops once disposed", () => {
    const dispose = observe();
    dispose();
    layers.openSession("writable");
    layers.closeSession();
    layers.startRestore("writable");
    layer.layerChanged.dispatch();
    expect(applied).toEqual([false]);
  });
});

describe("showSessionLayerLockOnIcon", () => {
  it("marks the icon disabled with the reason, then restores its title", () => {
    const icon = document.createElement("div");
    icon.title = "Delete layer";

    showSessionLayerLockOnIcon(icon, true, "Delete layer");
    expect(icon.getAttribute("aria-disabled")).toBe("true");
    expect(icon.title).toBe(SESSION_LAYER_LOCK_REASON);

    showSessionLayerLockOnIcon(icon, false, "Delete layer");
    expect(icon.hasAttribute("aria-disabled")).toBe(false);
    expect(icon.title).toBe("Delete layer");
  });
});

describe("bindSessionLayerDeleteIcon", () => {
  const HIDE_INSTEAD = "To hide it instead, click its eye icon.";
  let layers: FakeLayerRoot;
  let layer: ManagedUserLayer;
  let icon: HTMLElement;
  let confirm: MockInstance<(message?: string) => boolean>;
  let onDelete: ReturnType<typeof vi.fn>;
  let dispose: () => void;

  beforeEach(() => {
    layers = new FakeLayerRoot();
    layer = layers.addLayer("writable");
    icon = document.createElement("div");
    confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    onDelete = vi.fn();
    // Wired the way `bindLayerDeleteIcon` wires the layer UI's delete icons,
    // with the delete itself mocked.
    dispose = bindSessionLayerDeleteIcon(icon, layer, "Delete layer", {
      confirm: () => confirmLayerDeletion(layer, HIDE_INSTEAD),
      onDelete,
    });
  });

  afterEach(() => {
    confirm.mockRestore();
  });

  it("asks, then deletes a layer that is not part of a session", () => {
    expect(icon.hasAttribute("aria-disabled")).toBe(false);
    expect(icon.title).toBe("Delete layer");
    icon.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.lastCall![0]).toBe(
      `Delete layer "writable"? This can't be undone. ${HIDE_INSTEAD}`,
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("keeps the layer when the prompt is declined", () => {
    confirm.mockReturnValue(false);
    icon.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("keeps the layer when a session locks it while the prompt is up", () => {
    confirm.mockImplementation(() => {
      layers.openSession("writable");
      return true;
    });
    icon.click();
    expect(onDelete).not.toHaveBeenCalled();
    expect(icon.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the layer when a restore starts while the prompt is up", () => {
    confirm.mockImplementation(() => {
      layers.startRestore("writable");
      return true;
    });
    icon.click();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("shows the lock and neither asks nor deletes while the layer is in the session", () => {
    layers.openSession("writable");

    expect(icon.getAttribute("aria-disabled")).toBe("true");
    expect(icon.title).toBe(SESSION_LAYER_LOCK_REASON);
    icon.click();
    expect(confirm).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    layers.closeSession();

    expect(icon.hasAttribute("aria-disabled")).toBe(false);
    expect(icon.title).toBe("Delete layer");
    icon.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows the lock and neither asks nor deletes while the session is being restored", () => {
    layers.startRestore("writable");

    expect(icon.getAttribute("aria-disabled")).toBe("true");
    icon.click();
    expect(confirm).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    layers.endRestore();

    icon.click();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("neither asks, deletes nor tracks the lock once disposed", () => {
    dispose();
    icon.click();
    expect(confirm).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    layers.openSession("writable");
    expect(icon.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("layerGroupHoldsOnlyCopyOfSessionLayer", () => {
  let layers: FakeLayerRoot;
  let group: LayerManager;
  let otherGroup: LayerManager;

  beforeEach(() => {
    layers = new FakeLayerRoot();
    group = { managedLayers: [] } as unknown as LayerManager;
    otherGroup = { managedLayers: [] } as unknown as LayerManager;
  });

  function showIn(layer: ManagedUserLayer, ...groups: LayerManager[]) {
    for (const layerGroup of groups) {
      layerGroup.managedLayers.push(layer);
      layer.containers.add(layerGroup);
    }
  }

  it("is true for a session layer that only this group shows", () => {
    showIn(layers.addLayer("writable"), group);
    showIn(layers.addLayer("outsider"), group);
    layers.openSession("writable");
    expect(layerGroupHoldsOnlyCopyOfSessionLayer(group)).toBe(true);
  });

  it("is false once another group also shows the session layer", () => {
    showIn(layers.addLayer("writable"), group, otherGroup);
    layers.openSession("writable");
    expect(layerGroupHoldsOnlyCopyOfSessionLayer(group)).toBe(false);
  });

  it("is false for an archived session layer, which removal keeps", () => {
    const writable = layers.addLayer("writable");
    showIn(writable, group);
    writable.archived = true;
    layers.openSession("writable");
    expect(layerGroupHoldsOnlyCopyOfSessionLayer(group)).toBe(false);
  });

  it("is false without a session or without session layers in the group", () => {
    showIn(layers.addLayer("writable"), group);
    showIn(layers.addLayer("outsider"), otherGroup);
    expect(layerGroupHoldsOnlyCopyOfSessionLayer(group)).toBe(false);
    layers.openSession("outsider");
    expect(layerGroupHoldsOnlyCopyOfSessionLayer(group)).toBe(false);
  });
});
