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

import type { ObjectVersionLifetime } from "#src/kvstore/versioned/version_at_time.js";
import type {
  AsyncMemoizeWithProgress,
  StringMemoize,
} from "#src/util/memoize.js";
import { asyncMemoizeWithProgress } from "#src/util/memoize.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

// Histories are a few small records per object; this bounds memory to a few
// tens of MB even for a long session over an unsharded layer.
const MAX_CACHED_OBJECTS = 50000;

// Version times come from the storage server's clock, not this machine's. A
// listing is trusted to contain every write up to a time only once it was made
// at least this long after that time.
export const CLOCK_SKEW_MARGIN_MS = 5 * 60 * 1000;

// A listing not yet trusted for the requested time is refreshed, but at most
// this often per object.
export const RELIST_INTERVAL_MS = 10 * 1000;

interface CachedHistory {
  history: AsyncMemoizeWithProgress<ObjectVersionLifetime[]>;
  /** Local time the listing request was started. */
  listedAt: number;
}

/**
 * Version history per object, shared by every `versioned:` store of one
 * kvstore context. The full history is cached (not the version picked for one
 * time), so changing the selected time issues no new list requests — unless
 * the time is so recent that writes made after the listing could still be live
 * at it. Concurrent requests for the same object share one listing; a failed
 * listing is not cached.
 */
export class ObjectVersionHistoryCache {
  private histories = new Map<string, CachedHistory>();

  constructor(private now: () => number = Date.now) {}

  /**
   * @param time The time the history is needed for; `undefined` when any
   *     cached history will do.
   */
  get(
    objectUrl: string,
    time: number | undefined,
    listObjectVersions: (
      options: ProgressOptions,
    ) => Promise<ObjectVersionLifetime[]>,
    options: Partial<ProgressOptions>,
  ): Promise<ObjectVersionLifetime[]> {
    const { histories } = this;
    let cached = histories.get(objectUrl);
    if (cached !== undefined) {
      histories.delete(objectUrl);
      if (!this.covers(cached, time)) cached = undefined;
    }
    if (cached === undefined) {
      cached = {
        history: asyncMemoizeWithProgress(listObjectVersions),
        listedAt: this.now(),
      };
      if (histories.size >= MAX_CACHED_OBJECTS) {
        // Map iteration order is insertion order: evict the least recently used.
        histories.delete(histories.keys().next().value!);
      }
    }
    histories.set(objectUrl, cached);
    return cached.history(options);
  }

  private covers(cached: CachedHistory, time: number | undefined) {
    if (time === undefined) return true;
    if (cached.listedAt - CLOCK_SKEW_MARGIN_MS > time) return true;
    return this.now() - cached.listedAt < RELIST_INTERVAL_MS;
  }
}

export function getObjectVersionHistoryCache(
  memoize: StringMemoize,
): ObjectVersionHistoryCache {
  return memoize.getUncounted(
    "versioned:objectVersionHistory",
    () => new ObjectVersionHistoryCache(),
  );
}
