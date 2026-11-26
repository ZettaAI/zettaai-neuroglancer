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

import type { BaseKvStoreProvider } from "#src/kvstore/context.js";
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
import type {
  KvStoreProviderRegistry,
  SharedKvStoreContextBase,
} from "#src/kvstore/register.js";
import type { S3UrlKind } from "#src/kvstore/s3/list.js";
import {
  getS3BucketListing,
  getS3UrlKind,
  listS3CompatibleUrl,
  setS3UrlKind,
} from "#src/kvstore/s3/list.js";
import {
  getS3ObjectVersionUrl,
  listS3ObjectVersions,
} from "#src/kvstore/s3/list_versions.js";
import { joinBaseUrlAndPath } from "#src/kvstore/url.js";
import type { ObjectVersionStore } from "#src/kvstore/versioned/object_version_store.js";
import type { ObjectVersionLifetime } from "#src/kvstore/versioned/version_at_time.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk, HttpError } from "#src/util/http_request.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export class ReadableS3KvStore<
    SharedKvStoreContext extends SharedKvStoreContextBase,
  >
  implements KvStore, ObjectVersionStore
{
  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    public baseUrl: string,
    public baseUrlForDisplay: string,
    protected knownToBeVirtualHostedStyle: boolean,
    protected fetchOkImpl: FetchOk = fetchOk,
  ) {}

  stat(key: string, options: StatOptions): Promise<StatResponse | undefined> {
    const url = joinBaseUrlAndPath(this.baseUrl, key);
    return stat(this, key, url, options, this.fetchOkImpl);
  }

  read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const url = joinBaseUrlAndPath(this.baseUrl, key);
    return read(this, key, url, options, this.fetchOkImpl);
  }

  list(prefix: string, options: DriverListOptions): Promise<ListResponse> {
    const { progressListener } = options;
    using _span =
      progressListener === undefined
        ? undefined
        : new ProgressSpan(progressListener, {
            message: `Listing prefix ${this.getUrl(prefix)}`,
          });
    if (this.knownToBeVirtualHostedStyle) {
      return getS3BucketListing(
        this.baseUrl,
        prefix,
        this.fetchOkImpl,
        options,
      );
    }
    return listS3CompatibleUrl(
      joinBaseUrlAndPath(this.baseUrl, prefix),
      this.baseUrlForDisplay,
      this.sharedKvStoreContext.chunkManager.memoize,
      this.fetchOkImpl,
      options,
    );
  }

  /**
   * Lists every version of exactly `key` on a bucket with versioning enabled
   * (`s3:ListBucketVersions`).
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
    if (this.knownToBeVirtualHostedStyle) {
      return listS3ObjectVersions(this.baseUrl, key, this.fetchOkImpl, options);
    }
    const { memoize } = this.sharedKvStoreContext.chunkManager;
    // Same detection as `list`: whichever URL style answers is the right one.
    // One detection per origin is shared by all concurrent reads.
    const detections = memoize.getUncounted(
      "s3:versionListingUrlKindDetection",
      () => new Map<string, Promise<S3UrlKind | undefined>>(),
    );
    while (true) {
      const knownUrlKind = getS3UrlKind(memoize, this.baseUrlForDisplay);
      if (knownUrlKind === "virtual" || knownUrlKind === "path") {
        return this.listObjectVersionsWithUrlKind(knownUrlKind, key, options);
      }
      const detection = detections.get(this.baseUrlForDisplay);
      if (detection === undefined) {
        return this.detectAndListObjectVersions(detections, key, options);
      }
      const urlKind = await detection;
      // `undefined`: the read that started the detection was cancelled, which
      // says nothing about this read, so detect again.
      if (urlKind === undefined) {
        if (detections.get(this.baseUrlForDisplay) === detection) {
          detections.delete(this.baseUrlForDisplay);
        }
        continue;
      }
      return this.listObjectVersionsWithUrlKind(urlKind, key, options);
    }
  }

  /**
   * Detects the URL style while listing `key`, letting concurrent reads of the
   * same origin wait for the detection instead of starting their own.
   */
  private async detectAndListObjectVersions(
    detections: Map<string, Promise<S3UrlKind | undefined>>,
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<ObjectVersionLifetime[]> {
    const { memoize } = this.sharedKvStoreContext.chunkManager;
    const detected = this.detectVersionListingUrlKind(key, options);
    // The detection runs with this read's signal. Waiting reads get the URL
    // style, the detection's error, or `undefined` if only this read was
    // cancelled (they then detect again rather than fail with its abort).
    const detection = detected.then(
      ({ urlKind }) => urlKind,
      (error) => {
        if (options.signal?.aborted) return undefined;
        throw error;
      },
    );
    // Waiting reads see the failure; this caller reports it below.
    detection.catch(() => {});
    detections.set(this.baseUrlForDisplay, detection);
    try {
      const { result, urlKind } = await detected;
      setS3UrlKind(memoize, this.baseUrlForDisplay, urlKind);
      return result;
    } finally {
      if (detections.get(this.baseUrlForDisplay) === detection) {
        detections.delete(this.baseUrlForDisplay);
      }
    }
  }

  private async detectVersionListingUrlKind(
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<{ result: ObjectVersionLifetime[]; urlKind: S3UrlKind }> {
    try {
      return await Promise.any(
        (["virtual", "path"] as const).map(async (urlKind) => ({
          result: await this.listObjectVersionsWithUrlKind(
            urlKind,
            key,
            options,
          ),
          urlKind,
        })),
      );
    } catch (e) {
      options.signal?.throwIfAborted();
      const errors = e instanceof AggregateError ? e.errors : [e];
      // Both styles refused: report the permission error itself.
      if (
        errors.every(
          (error) =>
            error instanceof HttpError &&
            (error.status === 401 || error.status === 403),
        )
      ) {
        throw errors[0];
      }
      throw new Error(
        `Neither virtual hosted nor path-style S3 version listing supported`,
        { cause: e },
      );
    }
  }

  private listObjectVersionsWithUrlKind(
    urlKind: S3UrlKind,
    key: string,
    options: Partial<ProgressOptions>,
  ) {
    if (urlKind === "virtual") {
      return listS3ObjectVersions(this.baseUrl, key, this.fetchOkImpl, options);
    }
    // Path style: the first key component is the bucket.
    const separator = key.indexOf("/");
    if (separator === -1) {
      throw new Error(
        `Path-style S3 URL ${this.getUrl(key)} must specify bucket`,
      );
    }
    return listS3ObjectVersions(
      joinBaseUrlAndPath(this.baseUrl, key.substring(0, separator + 1)),
      key.substring(separator + 1),
      this.fetchOkImpl,
      options,
    );
  }

  readObjectVersion(
    key: string,
    versionId: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const url = getS3ObjectVersionUrl(
      joinBaseUrlAndPath(this.baseUrl, key),
      versionId,
    );
    return read(this, key, url, options, this.fetchOkImpl);
  }

  statObjectVersion(
    key: string,
    versionId: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const url = getS3ObjectVersionUrl(
      joinBaseUrlAndPath(this.baseUrl, key),
      versionId,
    );
    return stat(this, key, url, options, this.fetchOkImpl);
  }

  getUrl(path: string) {
    return joinBaseUrlAndPath(this.baseUrlForDisplay, path);
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}

function amazonS3Provider<
  SharedKvStoreContext extends SharedKvStoreContextBase,
>(
  sharedKvStoreContext: SharedKvStoreContext,
  s3KvStoreClass: typeof ReadableS3KvStore<SharedKvStoreContext>,
): BaseKvStoreProvider {
  return {
    scheme: "s3",
    description: "S3 (anonymous)",
    getKvStore(url) {
      const m = (url.suffix ?? "").match(/^\/\/([^/]+)(\/.*)?$/);
      if (m === null) {
        throw new Error("Invalid URL, expected `s3://<bucket>/<path>`");
      }
      const [, bucket, path] = m;
      return {
        store: new s3KvStoreClass(
          sharedKvStoreContext,
          `https://${bucket}.s3.amazonaws.com/`,
          `s3://${bucket}/`,
          /*knownToBeVirtualHostedStyle=*/ true,
        ),
        path: decodeURIComponent((path ?? "").substring(1)),
      };
    },
  };
}

function s3Provider<SharedKvStoreContext extends SharedKvStoreContextBase>(
  sharedKvStoreContext: SharedKvStoreContext,
  httpScheme: "http" | "https",
  s3KvStoreClass: typeof ReadableS3KvStore<SharedKvStoreContext>,
): BaseKvStoreProvider {
  return {
    scheme: `s3+${httpScheme}`,
    description: `S3-compatible ${httpScheme} server`,
    getKvStore(url) {
      const m = (url.suffix ?? "").match(/^\/\/([^/]+)(\/.*)?$/);
      if (m === null) {
        throw new Error(
          "Invalid URL, expected `s3+${httpScheme}://<host>/<path>`",
        );
      }
      const [, host, path] = m;
      return {
        store: new s3KvStoreClass(
          sharedKvStoreContext,
          `${httpScheme}://${host}/`,
          `s3+${httpScheme}://${host}/`,
          /*knownToBeVirtualHostedStyle=*/ false,
        ),
        path: decodeURIComponent((path ?? "").substring(1)),
      };
    },
  };
}

export function registerProviders<
  SharedKvStoreContext extends SharedKvStoreContextBase,
>(
  registry: KvStoreProviderRegistry<SharedKvStoreContext>,
  s3KvStoreClass: typeof ReadableS3KvStore<SharedKvStoreContext>,
) {
  registry.registerBaseKvStoreProvider((context) =>
    amazonS3Provider(context, s3KvStoreClass),
  );

  for (const httpScheme of ["http", "https"] as const) {
    registry.registerBaseKvStoreProvider((context) =>
      s3Provider(context, httpScheme, s3KvStoreClass),
    );
  }
}
