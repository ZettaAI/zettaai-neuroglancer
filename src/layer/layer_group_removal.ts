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
 * @file Which layers removing a layer group deletes along with it.
 */

import type { LayerManager, ManagedUserLayer } from "#src/layer/index.js";

/**
 * The layers that removing the layer group whose own layer manager is
 * `groupLayers` deletes, in the group's order.
 *
 * Removing a group clears `groupLayers`. A layer's `containers` are the root
 * layer manager plus the manager of each group that shows it, and the root
 * then drops every layer that no group shows unless it is archived (the root
 * manager's single-reference sweep, and the layout's collapse onto the last
 * remaining group). So removal deletes the non-archived layers that no other
 * group shows, and keeps the rest.
 */
export function layersDeletedByRemovingLayerGroup(
  groupLayers: LayerManager,
): ManagedUserLayer[] {
  return groupLayers.managedLayers.filter(
    (layer) =>
      !layer.archived &&
      [...layer.containers].every(
        (container) =>
          container === groupLayers || container === layer.manager.rootLayers,
      ),
  );
}
