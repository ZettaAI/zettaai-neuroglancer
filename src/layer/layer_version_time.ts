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
 * The time a layer is viewed at, chosen in its "Version history" (TM-521).
 *
 * Like the Calcada timestamp, the time is layer state of its own, not part of
 * the data source URL: switching versions keeps the data source loaded and
 * only makes the layer request its chunks again, at the new time.
 */

import {
  formatVersionTime,
  parseVersionTime,
} from "#src/kvstore/versioned/url.js";
import { siblingAtVersionTime } from "#src/kvstore/versioned/version_time_source.js";
import type { RenderLayer } from "#src/renderlayer.js";
import { TrackableValue } from "#src/trackable_value.js";
import type { Disposable, RefCounted } from "#src/util/disposable.js";
import type { NullarySignal } from "#src/util/signal.js";

/** Layer JSON key, e.g. `"versionTime": "2026-11-19T09:09:01Z"`. */
export const VERSION_TIME_JSON_KEY = "versionTime";

/** Epoch milliseconds; `undefined` (the default, not saved) = latest data. */
export class TrackableVersionTime extends TrackableValue<number | undefined> {
  constructor() {
    super(undefined, (json: unknown) => {
      if (typeof json !== "string") {
        throw new Error(`Expected a time string, got ${JSON.stringify(json)}`);
      }
      return parseVersionTime(json);
    });
  }

  toJSON() {
    const { value } = this;
    return value === undefined ? undefined : formatVersionTime(value);
  }
}

/**
 * Makes the layer's render layers request their chunks again (at the new
 * time), the way Calcada's `refreshChunkSources` does: a render layer
 * re-reads its sources when its transform signals a change. Volume
 * rendering also watches the time itself; re-reading twice is harmless.
 */
export function requestChunksAtNewVersionTime(
  renderLayers: readonly RenderLayer[],
) {
  for (const renderLayer of renderLayers) {
    const transform = (
      renderLayer as Partial<{ transform: { changed: NullarySignal } }>
    ).transform;
    transform?.changed.dispatch();
  }
}

/**
 * The mesh, skeleton or annotation `source` as the layer shows it: read at
 * the layer's `time` when the source supports that, kept alive by `owner`
 * (the activated subsource); otherwise `source` itself (latest data).
 */
export function sourceAtLayerVersionTime<T extends Disposable>(
  source: T,
  time: number | undefined,
  owner: RefCounted,
): T {
  const sibling = siblingAtVersionTime(source, time);
  if (sibling === undefined) return source;
  return owner.registerDisposer(sibling);
}
