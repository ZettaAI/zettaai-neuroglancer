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

import type { KvStoreAdapterProvider } from "#src/kvstore/context.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry } from "#src/kvstore/register.js";
import { ensurePathIsDirectory } from "#src/kvstore/url.js";
import { getObjectVersionHistoryCache } from "#src/kvstore/versioned/object_version_history_cache.js";
import { isObjectVersionStore } from "#src/kvstore/versioned/object_version_store.js";
import {
  parseVersionedUrl,
  VERSIONED_SCHEME,
} from "#src/kvstore/versioned/url.js";
import { VersionedKvStore } from "#src/kvstore/versioned/versioned_kvstore.js";

function versionedProvider(
  context: SharedKvStoreContextBase,
): KvStoreAdapterProvider {
  return {
    scheme: VERSIONED_SCHEME,
    description: "bucket with object versioning, read at a chosen time",
    getKvStore(parsedUrl, base) {
      const { time, path } = parseVersionedUrl(parsedUrl);
      const { store } = base;
      if (!isObjectVersionStore(store)) {
        throw new Error(
          `"${VERSIONED_SCHEME}:" requires a gs:// or s3:// bucket, ` +
            `not ${store.getUrl(base.path)}`,
        );
      }
      return {
        store: new VersionedKvStore(
          store,
          ensurePathIsDirectory(base.path),
          time,
          getObjectVersionHistoryCache(context.chunkManager.memoize),
        ),
        path,
      };
    },
  };
}

frontendBackendIsomorphicKvStoreProviderRegistry.registerKvStoreAdapterProvider(
  versionedProvider,
);
