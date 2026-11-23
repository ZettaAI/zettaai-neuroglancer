/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/** The layer bar as a user reaches it: a layer's item and its delete icon. */

import type { Locator, Page } from "@playwright/test";

/** `SESSION_LAYER_LOCK_REASON` in `session_layer_structure_lock.ts`. */
export const SESSION_LAYER_LOCK_REASON =
  "Locked while this layer is part of the active edit session.";

/** A regex matching exactly `name`. */
export function exactText(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** The layer bar item of `name` (first layer group that shows it). */
export function layerBarItem(page: Page, name: string): Locator {
  return page
    .locator(".neuroglancer-layer-item")
    .filter({
      has: page.locator(".neuroglancer-layer-item-label", {
        hasText: exactText(name),
      }),
    })
    .first();
}

/**
 * The layer bar trash icon of `name`: second icon of the item's button
 * container (after "Remove layer from this layer group"). Hovers the item
 * first — the container is `visibility: hidden` until the panel is hovered.
 */
export async function layerBarDeleteIcon(
  page: Page,
  name: string,
): Promise<Locator> {
  const item = layerBarItem(page, name);
  await item.hover();
  return item
    .locator(".neuroglancer-layer-item-button-container > .neuroglancer-icon")
    .nth(1);
}
