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
  DriverListOptions,
  DriverReadOptions,
  KvStore,
  ListResponse,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { KvStoreFileHandle, NotFoundError } from "#src/kvstore/index.js";
import type { ObjectVersionHistoryCache } from "#src/kvstore/versioned/object_version_history_cache.js";
import type {
  ObjectChangesPage,
  ObjectVersionStore,
} from "#src/kvstore/versioned/object_version_store.js";
import { getVersionedUrl } from "#src/kvstore/versioned/url.js";
import type { ObjectVersionLifetime } from "#src/kvstore/versioned/version_at_time.js";
import {
  earliestLiveTime,
  versionLiveAt,
} from "#src/kvstore/versioned/version_at_time.js";
import { HttpError } from "#src/util/http_request.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

/**
 * Reads a bucket with object versioning as it was at `time`.
 *
 * Keys are relative to `root` (a directory of the base store). Each key
 * resolves to the version that was live at `time`; a key with no live version
 * at that time reads as missing, never as the current object. Without a time
 * every call passes straight through to the base store (no extra requests).
 */
export class VersionedKvStore implements KvStore {
  constructor(
    private base: KvStore & ObjectVersionStore,
    private root: string,
    private time: number | undefined,
    private historyCache: ObjectVersionHistoryCache,
  ) {}

  async stat(
    key: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const baseKey = this.root + key;
    if (this.time === undefined) return this.base.stat(baseKey, options);
    const version = await this.findVersion(key, options);
    const response =
      version === undefined
        ? undefined
        : await this.base.statObjectVersion(
            baseKey,
            version.versionId,
            options,
          );
    return this.handleMissing(key, response, options);
  }

  async read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const baseKey = this.root + key;
    if (this.time === undefined) return this.base.read(baseKey, options);
    const version = await this.findVersion(key, options);
    const response =
      version === undefined
        ? undefined
        : await this.base.readObjectVersion(
            baseKey,
            version.versionId,
            options,
          );
    return this.handleMissing(key, response, options);
  }

  /**
   * Lists current keys, also when a time is chosen: listing is only used for
   * URL completion, and a point-in-time directory listing is not available
   * from the buckets.
   */
  async list(
    prefix: string,
    options: DriverListOptions,
  ): Promise<ListResponse> {
    const { base, root } = this;
    if (base.list === undefined) throw new Error("Listing not supported");
    const response = await base.list(root + prefix, options);
    const removeRoot = (key: string) => key.substring(root.length);
    return {
      directories: response.directories.map(removeRoot),
      entries: response.entries.map(({ key, ...entry }) => ({
        ...entry,
        key: removeRoot(key),
      })),
    };
  }

  getUrl(key: string): string {
    return getVersionedUrl(
      { baseUrl: this.base.getUrl(this.root), time: this.time },
      key,
    );
  }

  get supportsOffsetReads() {
    return this.base.supportsOffsetReads;
  }

  get supportsSuffixReads() {
    return this.base.supportsSuffixReads;
  }

  /** Earliest time any version of `key` was live, or `undefined` without history. */
  async earliestVersionTime(
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<number | undefined> {
    return earliestLiveTime(await this.getHistory(key, undefined, options));
  }

  /**
   * One page of changes under this layer (see
   * `ObjectVersionStore.listChangesUnder`), or `"no-permission"` when version
   * listing is refused.
   */
  async listChanges(
    cursor: string | undefined,
    options: Partial<ProgressOptions>,
  ): Promise<ObjectChangesPage | "no-permission"> {
    try {
      return await this.base.listChangesUnder(this.root, cursor, options);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        return "no-permission";
      }
      throw e;
    }
  }

  private getHistory(
    key: string,
    time: number | undefined,
    options: Partial<ProgressOptions>,
  ): Promise<ObjectVersionLifetime[]> {
    return this.historyCache.get(
      this.base.getUrl(this.root + key),
      time,
      (progressOptions) => this.listVersions(key, progressOptions),
      options,
    );
  }

  private async findVersion(
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<ObjectVersionLifetime | undefined> {
    const time = this.time!;
    return versionLiveAt(await this.getHistory(key, time, options), time);
  }

  private async listVersions(
    key: string,
    options: ProgressOptions,
  ): Promise<ObjectVersionLifetime[]> {
    try {
      return await this.base.listObjectVersions(this.root + key, options);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw new Error(
          `No permission to list object versions of ${this.base.getUrl(this.root + key)}; ` +
            "viewing a past time needs list access to the bucket",
          { cause: e },
        );
      }
      throw e;
    }
  }

  private handleMissing<T>(
    key: string,
    response: T | undefined,
    options: { throwIfMissing?: boolean },
  ): T | undefined {
    if (response === undefined && options.throwIfMissing === true) {
      throw new NotFoundError(new KvStoreFileHandle(this, key));
    }
    return response;
  }
}
