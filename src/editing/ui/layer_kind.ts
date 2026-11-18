/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { isVersionedUrl } from "#src/kvstore/versioned/url.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";

export type LayerKind = "image" | "segmentation";

export function layerKindOf(
  managed: ManagedUserLayer | undefined,
): LayerKind | undefined {
  if (managed === undefined) return undefined;
  const userLayer = managed.layer;
  if (userLayer instanceof SegmentationUserLayer) return "segmentation";
  if (userLayer instanceof ImageUserLayer) return "image";
  return undefined;
}

/**
 * Data source schemes that cannot participate in an edit session as
 * Reference or Editable layers (TM-312, TM-374). Layers backed by these
 * sources may only be Off — this is a product restriction, not a technical
 * fault of the layer, which stays fully usable outside the session.
 *
 * `versioned` covers any source read through `|versioned:`: at a past time
 * the save path writes to the bucket's current objects, so editing past data
 * would overwrite the live layer with it; and the save path cuts the URL at
 * the first `|`, dropping any path after `versioned:`.
 */
export type BlockedScheme = "calcada" | "graphene" | "middleauth" | "versioned";

/**
 * URL test for each blocked scheme. `middleauth` layers carry a
 * `middleauth+<httpScheme>://` URL (the kvstore registers the scheme as
 * `middleauth+https`), so match the `middleauth+` prefix rather than a bare
 * `scheme://`. `versioned:` may appear anywhere in the pipeline.
 */
const BLOCKED_SCHEME_MATCHERS: ReadonlyArray<
  readonly [BlockedScheme, (url: string) => boolean]
> = [
  ["calcada", (url) => url.startsWith("calcada://")],
  ["graphene", (url) => url.startsWith("graphene://")],
  ["middleauth", (url) => url.startsWith("middleauth+")],
  ["versioned", isVersionedUrl],
];

/**
 * Returns the blocked data source scheme backing `managed`, if any. Reads
 * the data source spec URLs, which are available synchronously (no need to
 * wait for the sources to load).
 */
export function blockedSchemeOf(
  managed: ManagedUserLayer | undefined,
): BlockedScheme | undefined {
  const userLayer = managed?.layer;
  if (userLayer == null) return undefined;
  for (const dataSource of userLayer.dataSources) {
    const url = dataSource.spec.url;
    for (const [scheme, matches] of BLOCKED_SCHEME_MATCHERS) {
      if (matches(url)) return scheme;
    }
  }
  return undefined;
}
