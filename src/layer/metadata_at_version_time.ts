/**
 * @license
 * Copyright 2026 Zetta AI.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Zetta (TM-523): a layer viewed at a past time also uses the metadata
 * (`info`: scales, bounds, segment properties) of that time.
 *
 * A data source is loaded once, with the current `info`; choosing a time
 * only makes it read its chunks at that time, which is fast. That is right
 * as long as `info` did not change since. So for each chosen time the layer's
 * `info` at that time is compared with the current one: when they differ,
 * the data source is loaded again with everything read at that time.
 */

import type { KvStoreContext } from "#src/kvstore/context.js";
import {
  setVersionTimeInUrl,
  versionedKvStoreUrlOf,
} from "#src/kvstore/versioned/url.js";
import type { UserLayer } from "#src/layer/index.js";
import type { LayerDataSource } from "#src/layer/layer_data_source.js";

async function readInfoText(
  kvStoreContext: KvStoreContext,
  kvStoreUrl: string,
  time: number | undefined,
): Promise<string | undefined> {
  const response = await kvStoreContext.read(
    setVersionTimeInUrl(kvStoreUrl, time) + "info",
  );
  return response === undefined ? undefined : response.response.text();
}

/**
 * Time to load the data source `url` at so that its metadata matches the
 * layer's `time`: `undefined` (the current data source) when its `info` at
 * `time` is the same as the current one, or when no time is chosen;
 * otherwise `time`.
 */
export async function metadataLoadTimeFor(
  kvStoreContext: KvStoreContext,
  url: string,
  time: number | undefined,
): Promise<number | undefined> {
  if (time === undefined) return undefined;
  const kvStoreUrl = versionedKvStoreUrlOf(url);
  if (kvStoreUrl === undefined) return undefined;
  const [infoAtTime, currentInfo] = await Promise.all([
    readInfoText(kvStoreContext, kvStoreUrl, time),
    readInfoText(kvStoreContext, kvStoreUrl, undefined),
  ]);
  return infoAtTime === currentInfo ? undefined : time;
}

/**
 * Keeps every data source of `layer` loaded with the metadata of the layer's
 * time. Returns the function that stops watching.
 */
export function keepMetadataAtVersionTime(layer: UserLayer): () => void {
  // What each data source was last checked for (URL and time), so the
  // reloads this causes do not start the same check again.
  const checked = new WeakMap<LayerDataSource, string>();

  const check = (dataSource: LayerDataSource) => {
    const { url } = dataSource.spec;
    const time = layer.versionTime.value;
    const key = `${time}|${url}`;
    if (url.length === 0 || checked.get(dataSource) === key) return;
    checked.set(dataSource, key);
    if (time === undefined) {
      dataSource.loadAtVersionTime(undefined);
      return;
    }
    const { kvStoreContext } =
      layer.manager.dataSourceProviderRegistry.sharedKvStoreContext;
    metadataLoadTimeFor(kvStoreContext, url, time).then(
      (loadTime) => {
        if (dataSource.wasDisposed || checked.get(dataSource) !== key) return;
        dataSource.loadAtVersionTime(loadTime);
      },
      () => {
        // `info` could not be read (e.g. no permission): the data source
        // stays as it is and reports read errors itself.
      },
    );
  };

  const checkAll = () => {
    for (const dataSource of layer.dataSources) check(dataSource);
  };
  const removeTimeListener = layer.versionTime.changed.add(checkAll);
  const removeSourcesListener = layer.dataSourcesChanged.add(checkAll);
  return () => {
    removeTimeListener();
    removeSourcesListener();
  };
}
