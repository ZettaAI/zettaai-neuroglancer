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
 * @file Prompts shown before a click in the layer UI deletes layers: a layer's
 * delete icon (layer bar, layer list panel, layer side panel), and "Remove
 * layer group" when the group shows the only copy of a layer. A deleted layer
 * cannot be brought back, and a delete is often meant as a hide.
 *
 * Only those clicks ask. `deleteLayer`, the `LayerManager` and state restore
 * (JSON state editor, URL hash) delete without a prompt.
 */

import { bindSessionLayerDeleteIcon } from "#src/editing/adapters/session_layer_structure_lock.js";
import type { LayerManager, ManagedUserLayer } from "#src/layer/index.js";
import { deleteLayer } from "#src/layer/index.js";
import { layersDeletedByRemovingLayerGroup } from "#src/layer/layer_group_removal.js";

const CANNOT_BE_UNDONE = "This can't be undone.";

/**
 * Layers a group-removal prompt names before summarizing the rest; one more is
 * named rather than counted as "1 more".
 */
const MAX_NAMED_LAYERS = 5;

/** Hint for the layer bar, where clicking a layer's name toggles it. */
export const LAYER_BAR_HIDE_INSTEAD =
  "To hide it instead, click its name in the layer bar.";

/** Hint for the layer list panel, which has an eye icon per layer. */
export const LAYER_LIST_PANEL_HIDE_INSTEAD =
  "To hide it instead, click its eye icon.";

/** Hint for the layer side panel, which has no visibility toggle of its own. */
export const LAYER_SIDE_PANEL_HIDE_INSTEAD =
  "To hide it instead, click its name in the layer bar or its eye icon in the layer list panel.";

/**
 * Wire a layer UI delete icon for `layer`: a click asks
 * ({@link confirmLayerDeletion} with `hideInstead`) and deletes the layer with
 * `deleteLayer` if the user agrees. A layer of the active edit session is
 * locked instead (`bindSessionLayerDeleteIcon`): the icon is disabled, and a
 * session that locks the layer while the prompt is up keeps it. Returns the
 * disposer.
 */
export function bindLayerDeleteIcon(
  icon: HTMLElement,
  layer: ManagedUserLayer,
  unlockedTitle: string,
  hideInstead: string,
): () => void {
  return bindSessionLayerDeleteIcon(icon, layer, unlockedTitle, {
    confirm: () => confirmLayerDeletion(layer, hideInstead),
    onDelete: () => deleteLayer(layer),
  });
}

/**
 * Ask before deleting `layer`. `hideInstead` tells the user how to hide the
 * layer from where they are deleting it; it is left out when the layer is
 * already hidden. Returns whether the user agreed.
 */
export function confirmLayerDeletion(
  layer: ManagedUserLayer,
  hideInstead: string,
): boolean {
  const message = `Delete layer "${layer.name}"? ${CANNOT_BE_UNDONE}`;
  return window.confirm(layer.visible ? `${message} ${hideInstead}` : message);
}

/**
 * Ask before removing the layer group whose own layer manager is
 * `groupLayers`, naming the layers that removal deletes
 * ({@link layersDeletedByRemovingLayerGroup}). Returns `true` without asking
 * when it deletes none. Otherwise returns whether the user agreed.
 */
export function confirmLayerGroupRemoval(groupLayers: LayerManager): boolean {
  const deletedLayers = layersDeletedByRemovingLayerGroup(groupLayers);
  if (deletedLayers.length === 0) return true;
  return window.confirm(layerGroupRemovalMessage(deletedLayers));
}

function layerGroupRemovalMessage(
  deletedLayers: readonly ManagedUserLayer[],
): string {
  const question = "Remove this layer group?";
  if (deletedLayers.length === 1) {
    return `${question} This also deletes layer "${deletedLayers[0].name}", which no other layer group shows. ${CANNOT_BE_UNDONE}`;
  }
  return `${question} This also deletes ${deletedLayers.length} layers that no other layer group shows: ${namedLayerList(deletedLayers)}. ${CANNOT_BE_UNDONE}`;
}

/**
 * `"a", "b" and "c"`. Up to six layers are all named; from seven on, the first
 * five are named and the rest counted: `"a", "b", "c", "d", "e" and 2 more`.
 */
function namedLayerList(layers: readonly ManagedUserLayer[]): string {
  const shown =
    layers.length <= MAX_NAMED_LAYERS + 1
      ? layers
      : layers.slice(0, MAX_NAMED_LAYERS);
  const names = shown.map((layer) => `"${layer.name}"`);
  const unnamedCount = layers.length - names.length;
  const last = unnamedCount === 0 ? names.pop()! : `${unnamedCount} more`;
  return `${names.join(", ")} and ${last}`;
}
