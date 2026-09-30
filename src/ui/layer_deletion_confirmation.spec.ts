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
 * The prompts the layer UI shows before deleting layers, with `window.confirm`
 * stubbed, the delete icon wiring each layer UI uses, and that deleting through
 * the model never prompts. The layers stand in for `ManagedUserLayer` with what
 * the real `LayerManager`s and the session lock use: signals, `containers`,
 * `archived`, `visible`, the reference count, `manager.rootLayers` and
 * `manager.root` (with no edit-session host, so nothing is locked; the lock is
 * covered in `tests/editing/unit/adapters/session_layer_structure_lock.spec.ts`).
 */

import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ManagedUserLayer } from "#src/layer/index.js";
import { deleteLayer, LayerManager } from "#src/layer/index.js";
import {
  bindLayerDeleteIcon,
  confirmLayerDeletion,
  confirmLayerGroupRemoval,
  LAYER_BAR_HIDE_INSTEAD,
  LAYER_LIST_PANEL_HIDE_INSTEAD,
  LAYER_SIDE_PANEL_HIDE_INSTEAD,
} from "#src/ui/layer_deletion_confirmation.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

class ShownLayer extends RefCounted {
  readonly layerChanged = new NullarySignal();
  readonly readyStateChanged = new NullarySignal();
  readonly specificationChanged = new NullarySignal();
  readonly containers = new Set<LayerManager>();
  archived = false;
  visible = true;

  constructor(
    readonly name: string,
    readonly manager: {
      readonly rootLayers: LayerManager;
      readonly root: { readonly editSessionHost: undefined };
    },
  ) {
    super();
  }
}

const HIDE_INSTEAD = "To hide it instead, click its eye icon.";

let confirm: MockInstance<(message?: string) => boolean>;
let rootLayers: LayerManager;
let group: LayerManager;
let otherGroup: LayerManager;

beforeEach(() => {
  confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  rootLayers = new LayerManager();
  group = new LayerManager();
  otherGroup = new LayerManager();
});

afterEach(() => {
  confirm.mockRestore();
});

/** A layer in the root manager, also shown by each of `groups`. */
function addLayer(name: string, ...groups: LayerManager[]): ManagedUserLayer {
  const layer = new ShownLayer(name, {
    rootLayers,
    root: { editSessionHost: undefined },
  }) as unknown as ManagedUserLayer;
  rootLayers.addManagedLayer(layer);
  for (const shownBy of groups) shownBy.addManagedLayer(layer.addRef());
  return layer;
}

function lastPrompt(): string {
  return confirm.mock.lastCall![0]!;
}

/** Let the root manager's single-reference sweep dispose dropped layers. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("confirmLayerDeletion", () => {
  it("names the layer and says how to hide it instead", () => {
    const layer = addLayer("segmentation", group);

    expect(confirmLayerDeletion(layer, HIDE_INSTEAD)).toBe(true);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(lastPrompt()).toBe(
      `Delete layer "segmentation"? This can't be undone. ${HIDE_INSTEAD}`,
    );
  });

  it("does not suggest hiding a layer that is already hidden", () => {
    const layer = addLayer("segmentation", group);
    layer.visible = false;

    confirmLayerDeletion(layer, HIDE_INSTEAD);

    expect(lastPrompt()).toBe(
      `Delete layer "segmentation"? This can't be undone.`,
    );
  });

  it("returns false when the user declines", () => {
    confirm.mockReturnValue(false);
    expect(confirmLayerDeletion(addLayer("segmentation"), HIDE_INSTEAD)).toBe(
      false,
    );
  });
});

describe("confirmLayerGroupRemoval", () => {
  it("does not ask when every layer stays in another group or archived", () => {
    addLayer("shared", group, otherGroup);
    const archived = addLayer("archived", group);
    archived.archived = true;

    expect(confirmLayerGroupRemoval(group)).toBe(true);

    expect(confirm).not.toHaveBeenCalled();
  });

  it("names the one layer that removal deletes", () => {
    addLayer("shared", group, otherGroup);
    addLayer("segmentation", group);

    expect(confirmLayerGroupRemoval(group)).toBe(true);

    expect(lastPrompt()).toBe(
      `Remove this layer group? This also deletes layer "segmentation", which no other layer group shows. This can't be undone.`,
    );
  });

  it("names each layer that removal deletes and none it keeps", () => {
    addLayer("image", group);
    addLayer("shared", group, otherGroup);
    addLayer("segmentation", group);
    addLayer("annotations", group);

    confirmLayerGroupRemoval(group);

    expect(lastPrompt()).toBe(
      `Remove this layer group? This also deletes 3 layers that no other layer group shows: "image", "segmentation" and "annotations". This can't be undone.`,
    );
  });

  it("names all six layers rather than counting one", () => {
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      addLayer(name, group);
    }

    confirmLayerGroupRemoval(group);

    expect(lastPrompt()).toBe(
      `Remove this layer group? This also deletes 6 layers that no other layer group shows: "a", "b", "c", "d", "e" and "f". This can't be undone.`,
    );
  });

  it("names the first five layers and counts the rest", () => {
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      addLayer(name, group);
    }

    confirmLayerGroupRemoval(group);

    expect(lastPrompt()).toBe(
      `Remove this layer group? This also deletes 7 layers that no other layer group shows: "a", "b", "c", "d", "e" and 2 more. This can't be undone.`,
    );
  });

  it("returns false when the user declines", () => {
    addLayer("segmentation", group);
    confirm.mockReturnValue(false);
    expect(confirmLayerGroupRemoval(group)).toBe(false);
  });
});

describe("bindLayerDeleteIcon", () => {
  let icon: HTMLElement;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    icon = document.createElement("div");
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("asks, then deletes the layer when the user agrees", async () => {
    const layer = addLayer("segmentation", group);
    dispose = bindLayerDeleteIcon(
      icon,
      layer,
      "Delete layer",
      LAYER_LIST_PANEL_HIDE_INSTEAD,
    );
    expect(icon.title).toBe("Delete layer");

    icon.click();
    await settle();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(rootLayers.managedLayers).not.toContain(layer);
    expect(group.managedLayers).not.toContain(layer);
    expect(layer.wasDisposed).toBe(true);
  });

  it("keeps the layer when the user declines", async () => {
    confirm.mockReturnValue(false);
    const layer = addLayer("segmentation", group);
    dispose = bindLayerDeleteIcon(
      icon,
      layer,
      "Delete layer",
      LAYER_LIST_PANEL_HIDE_INSTEAD,
    );

    icon.click();
    await settle();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(rootLayers.managedLayers).toContain(layer);
    expect(group.managedLayers).toContain(layer);
    expect(layer.wasDisposed).toBeFalsy();
  });

  it.each([
    ["layer bar", LAYER_BAR_HIDE_INSTEAD],
    ["layer list panel", LAYER_LIST_PANEL_HIDE_INSTEAD],
    ["layer side panel", LAYER_SIDE_PANEL_HIDE_INSTEAD],
  ])("puts the %s hint in the prompt", (_place, hideInstead) => {
    confirm.mockReturnValue(false);
    const layer = addLayer("segmentation", group);
    dispose = bindLayerDeleteIcon(icon, layer, "Delete layer", hideInstead);

    icon.click();

    expect(lastPrompt()).toBe(
      `Delete layer "segmentation"? This can't be undone. ${hideInstead}`,
    );
  });
});

describe("deleting through the model", () => {
  it("never prompts", async () => {
    const deleted = addLayer("deleted", group, otherGroup);
    const removed = addLayer("removed", otherGroup);
    addLayer("cleared", group);

    deleteLayer(deleted);
    otherGroup.removeManagedLayer(removed);
    group.clear();
    rootLayers.clear();
    await settle();

    expect(deleted.wasDisposed).toBe(true);
    expect(rootLayers.managedLayers).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });
});
