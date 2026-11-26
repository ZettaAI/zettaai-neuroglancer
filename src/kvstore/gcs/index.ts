/**
 * @license
 * Copyright 2024 Google Inc.
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

import { read, stat } from "#src/kvstore/http/read.js";
import type {
  KvStore,
  DriverListOptions,
  ListResponse,
  DriverReadOptions,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { encodePathForUrl } from "#src/kvstore/url.js";
import type { ObjectVersionStore } from "#src/kvstore/versioned/object_version_store.js";
import { parseListingTime } from "#src/kvstore/versioned/object_version_store.js";
import type {
  GcsObjectGeneration,
  ObjectVersionLifetime,
} from "#src/kvstore/versioned/version_at_time.js";
import { gcsGenerationLifetimes } from "#src/kvstore/versioned/version_at_time.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk } from "#src/util/http_request.js";
import {
  parseArray,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { getRandomHexString } from "#src/util/random.js";

export class GcsKvStore implements KvStore, ObjectVersionStore {
  constructor(
    public bucket: string,
    public baseUrlForDisplay: string = `gs://${bucket}/`,
    private fetchOkImpl: FetchOk = fetchOk,
  ) {}

  private getObjectUrl(key: string, generation?: string): string {
    // Include random query string parameter (ignored by GCS) to bypass GCS cache
    // and ensure a cached response is never used.
    //
    // This addresses two issues related to GCS:
    //
    // 1. GCS fails to send an updated `Access-Control-Allow-Origin` header in 304
    //    responses to cache revalidation requests.
    //
    //    https://bugs.chromium.org/p/chromium/issues/detail?id=1214563#c2
    //
    //    The random query string parameter ensures cached responses are never used.
    //
    //    Note: This issue does not apply to gs+xml because with the XML API, the
    //    Access-Control-Allow-Origin response header does not vary with the Origin.
    //
    // 2. If the object does not prohibit caching (e.g. public bucket and default
    //    `cache-control` metadata value), GCS may return stale responses.
    return (
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/` +
      `${encodeURIComponent(key)}?alt=media` +
      (generation === undefined
        ? ""
        : `&generation=${encodeURIComponent(generation)}`) +
      `&neuroglancer=${getRandomHexString()}`
    );
  }

  stat(key: string, options: StatOptions): Promise<StatResponse | undefined> {
    return stat(this, key, this.getObjectUrl(key), options, this.fetchOkImpl);
  }

  read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    return read(this, key, this.getObjectUrl(key), options, this.fetchOkImpl);
  }

  async list(
    prefix: string,
    options: DriverListOptions,
  ): Promise<ListResponse> {
    const { progressListener } = options;
    using _span =
      progressListener === undefined
        ? undefined
        : new ProgressSpan(progressListener, {
            message: `Listing prefix ${this.getUrl(prefix)}`,
          });
    const delimiter = "/";
    // Include `neuroglancerOrigin` query parameter that is ignored by GCS to
    // workaround
    // https://bugs.chromium.org/p/chromium/issues/detail?id=1214563#c2 (though
    // it is not clear it would ever apply to bucket listing).
    const response = await this.fetchOkImpl(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?` +
        `delimiter=${encodeURIComponent(delimiter)}&prefix=${encodeURIComponent(
          prefix,
        )}&` +
        `neuroglancerOrigin=${encodeURIComponent(location.origin)}`,
      {
        signal: options.signal,
        progressListener: options.progressListener,
      },
    );
    const responseJson = await response.json();

    verifyObject(responseJson);
    const directories = verifyOptionalObjectProperty(
      responseJson,
      "prefixes",
      verifyStringArray,
      [],
    ).map((prefix) => prefix.substring(0, prefix.length - 1));

    const entries = verifyOptionalObjectProperty(
      responseJson,
      "items",
      (items) =>
        parseArray(items, (item) => {
          verifyObject(item);
          return verifyObjectProperty(item, "name", verifyString);
        }),
      [],
    )
      .filter((name) => !name.endsWith("_$folder$"))
      .map((name) => ({ key: name }));

    return {
      directories,
      entries,
    };
  }

  /**
   * Lists every generation of exactly `key` on a bucket with object versioning
   * (noncurrent generations included). Requires `storage.objects.list`.
   */
  async listObjectVersions(
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<ObjectVersionLifetime[]> {
    const { progressListener } = options;
    using _span =
      progressListener === undefined
        ? undefined
        : new ProgressSpan(progressListener, {
            message: `Listing versions of ${this.getUrl(key)}`,
          });
    const generations: GcsObjectGeneration[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.fetchOkImpl(
        `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?` +
          `versions=true&prefix=${encodeURIComponent(key)}` +
          // Bound the listing to exactly `key`: without it, `by_id/1` would
          // page through every version of `by_id/1*`.
          `&startOffset=${encodeURIComponent(key)}` +
          `&endOffset=${encodeURIComponent(key + "\x01")}` +
          `&fields=${encodeURIComponent("items(name,generation,timeCreated,timeDeleted),nextPageToken")}` +
          (pageToken === undefined
            ? ""
            : `&pageToken=${encodeURIComponent(pageToken)}`) +
          `&neuroglancerOrigin=${encodeURIComponent(location.origin)}`,
        { signal: options.signal, progressListener },
      );
      const responseJson = await response.json();
      verifyObject(responseJson);
      const items = verifyOptionalObjectProperty(
        responseJson,
        "items",
        (items) => parseArray(items, parseGcsGenerationListItem),
        [],
      );
      for (const { name, generation } of items) {
        // Defensive: the offsets already exclude longer keys (`info_old`).
        if (name === key) generations.push(generation);
      }
      pageToken = verifyOptionalObjectProperty(
        responseJson,
        "nextPageToken",
        verifyString,
      );
    } while (pageToken !== undefined);
    return gcsGenerationLifetimes(generations);
  }

  readObjectVersion(
    key: string,
    versionId: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    return read(
      this,
      key,
      this.getObjectUrl(key, versionId),
      options,
      this.fetchOkImpl,
    );
  }

  statObjectVersion(
    key: string,
    versionId: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    return stat(
      this,
      key,
      this.getObjectUrl(key, versionId),
      options,
      this.fetchOkImpl,
    );
  }

  getUrl(path: string) {
    return this.baseUrlForDisplay + encodePathForUrl(path);
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}

function parseGcsGenerationListItem(item: unknown): {
  name: string;
  generation: GcsObjectGeneration;
} {
  verifyObject(item);
  const timeDeleted = verifyOptionalObjectProperty(
    item,
    "timeDeleted",
    verifyString,
  );
  return {
    name: verifyObjectProperty(item, "name", verifyString),
    generation: {
      generation: verifyObjectProperty(item, "generation", verifyString),
      timeCreated: parseListingTime(
        verifyObjectProperty(item, "timeCreated", verifyString),
      ),
      timeDeleted:
        timeDeleted === undefined ? undefined : parseListingTime(timeDeleted),
    },
  };
}
