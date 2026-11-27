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
 * @file The graph's image, read through calcada so it follows the branch: a
 * calcada layer brings it in as a layer of its own, under itself, unless one
 * already reads it.
 */

import {
  graphImageSource,
  isCalcadaImageSource,
} from "#src/datasource/calcada/realign/image_source.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { LayerListSpecification, UserLayer } from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import type { LayerDataSource } from "#src/layer/layer_data_source.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";

export interface GraphImage {
  /** The graph's table name; the layer is named after it. */
  readonly table: string;
  /** The calcada layer's `…/table/{graph}`, `middleauth+` prefix included. */
  readonly segmentationUrl: string;
  /** The graph's resolved calcada URL, as image sources are matched against. */
  readonly graphUrl: string;
  readonly branchId: WatchableValueInterface<number>;
  /** Whether calcada serves an image for the graph; throws when it cannot tell. */
  hasImage(): Promise<boolean>;
}

const LAYER_NAME_SUFFIX = " image";
// The first request commonly races calcada's middleauth handshake.
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1500;

/** The image layers' data sources that read the graph at `graphUrl` through calcada. */
export function* graphImageDataSources(
  layers: LayerListSpecification,
  graphUrl: string,
): Generator<LayerDataSource> {
  for (const { layer } of layers.rootLayers.managedLayers) {
    if (!(layer instanceof ImageUserLayer)) continue;
    for (const dataSource of layer.dataSources) {
      if (isCalcadaImageSource(dataSource.spec.url, graphUrl)) {
        yield dataSource;
      }
    }
  }
}

function hasGraphImageLayer(
  layers: LayerListSpecification,
  graphUrl: string,
): boolean {
  return graphImageDataSources(layers, graphUrl).next().done !== true;
}

export async function addGraphImageLayer(
  layers: LayerListSpecification,
  host: UserLayer,
  image: GraphImage,
  isStopped: () => boolean,
): Promise<void> {
  if (hasGraphImageLayer(layers, image.graphUrl)) return;
  const hasImage = await graphHasImage(image, isStopped);
  // Another calcada layer over the graph may have added it meanwhile.
  if (!hasImage || isStopped() || hasGraphImageLayer(layers, image.graphUrl)) {
    return;
  }
  const managed = makeLayer(layers, `${image.table}${LAYER_NAME_SUFFIX}`, {
    type: "image",
    source: graphImageSource(image.segmentationUrl, image.branchId.value),
  });
  const hostIndex = layers.rootLayers.managedLayers.findIndex(
    (candidate) => candidate.layer === host,
  );
  layers.add(managed, hostIndex === -1 ? undefined : hostIndex);
}

async function graphHasImage(
  image: GraphImage,
  isStopped: () => boolean,
): Promise<boolean> {
  for (let attempt = 1; ; ++attempt) {
    try {
      return await image.hasImage();
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || isStopped()) {
        console.warn(
          "Could not tell whether the calcada graph has an image:",
          error,
        );
        return false;
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RETRY_DELAY_MS * attempt),
    );
  }
}
