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

import type {
  DriverReadOptions,
  KvStore,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import type { ObjectVersionLifetime } from "#src/kvstore/versioned/version_at_time.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

/**
 * Optional capability of a base kvstore backed by a bucket with object
 * versioning: list every stored version of one key and read a specific one.
 */
export interface ObjectVersionStore {
  /** All stored versions of exactly `key` (not keys that merely share the prefix). */
  listObjectVersions(
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<ObjectVersionLifetime[]>;
  readObjectVersion(
    key: string,
    versionId: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined>;
  statObjectVersion(
    key: string,
    versionId: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined>;
  /**
   * Whether the first page of the version listing under `prefix` holds an
   * earlier (noncurrent) version or a delete marker: one cheap request that
   * tells a bucket with history from one without (no object versioning, or
   * nothing rewritten yet). A large directory can have history only past the
   * first page, so `false` means "none found", not "none".
   */
  hasEarlierVersions(
    prefix: string,
    options: Partial<ProgressOptions>,
  ): Promise<boolean>;
}

/** Versions looked at by `hasEarlierVersions` (one listing page). */
export const EARLIER_VERSIONS_PAGE_SIZE = 1000;

export function isObjectVersionStore(
  store: KvStore,
): store is KvStore & ObjectVersionStore {
  const candidate = store as Partial<ObjectVersionStore>;
  return (
    typeof candidate.listObjectVersions === "function" &&
    typeof candidate.readObjectVersion === "function" &&
    typeof candidate.statObjectVersion === "function" &&
    typeof candidate.hasEarlierVersions === "function"
  );
}

/** Parses an RFC 3339 timestamp from a bucket listing into epoch milliseconds. */
export function parseListingTime(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error(
      `Invalid timestamp in version listing: ${JSON.stringify(value)}`,
    );
  }
  return time;
}
