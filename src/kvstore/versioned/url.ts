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

import type { UrlWithParsedScheme } from "#src/kvstore/url.js";
import {
  encodePathForUrl,
  ensureNoQueryOrFragmentParameters,
} from "#src/kvstore/url.js";

export const VERSIONED_SCHEME = "versioned";

// Same timestamp syntax as the OCDBT `@<time>` version specifier.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Parses `2026-11-10T12:00:00Z` (optional fractional seconds) into epoch milliseconds. */
export function parseVersionTime(timestamp: string): number {
  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    throw new Error(
      `Invalid version time ${JSON.stringify(timestamp)}, expected e.g. "2026-11-10T12:00:00Z"`,
    );
  }
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) {
    throw new Error(`Invalid version time ${JSON.stringify(timestamp)}`);
  }
  return time;
}

/** Formats epoch milliseconds as `2026-11-10T12:00:00Z` (milliseconds only when non-zero). */
export function formatVersionTime(time: number): string {
  return new Date(time).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * Adapter URL part, e.g. `versioned:@2026-11-10T12:00:00Z/` (time chosen) or
 * `versioned:` (current data).
 */
export function formatVersionedUrlPart(time: number | undefined): string {
  return time === undefined
    ? `${VERSIONED_SCHEME}:`
    : `${VERSIONED_SCHEME}:@${formatVersionTime(time)}/`;
}

export function getVersionedUrl(
  options: { baseUrl: string; time: number | undefined },
  key: string,
): string {
  return (
    options.baseUrl +
    "|" +
    formatVersionedUrlPart(options.time) +
    encodePathForUrl(key)
  );
}

export function parseVersionedUrl(parsedUrl: UrlWithParsedScheme): {
  time: number | undefined;
  path: string;
} {
  ensureNoQueryOrFragmentParameters(parsedUrl);
  // Infallible pattern.
  const [, timestamp, path] = (parsedUrl.suffix ?? "").match(
    /^(?:@([^/]*)(?:\/|$))?(.*)$/,
  )!;
  try {
    return {
      time: timestamp === undefined ? undefined : parseVersionTime(timestamp),
      path: decodeURIComponent(path),
    };
  } catch (e) {
    throw new Error(`Invalid URL: ${parsedUrl.url}`, { cause: e });
  }
}

const VERSIONED_URL_PART_PATTERN = /\|versioned:(?:@([^/|]*)\/?)?/;

/** True if a pipeline URL reads through the `versioned:` adapter. */
export function isVersionedUrl(url: string): boolean {
  return VERSIONED_URL_PART_PATTERN.test(url);
}

/**
 * Time chosen in a pipeline URL's `versioned:` part, or `undefined` when the
 * URL has no `versioned:` part or no time (current data). Throws on an
 * invalid time.
 */
export function getVersionTimeFromUrl(url: string): number | undefined {
  const match = url.match(VERSIONED_URL_PART_PATTERN);
  if (match === null || match[1] === undefined) return undefined;
  return parseVersionTime(match[1]);
}

/**
 * Rewrites the time of the `versioned:` part of a pipeline URL. `undefined`
 * returns to current data. URLs without a `versioned:` part are returned as is.
 */
export function setVersionTimeInUrl(
  url: string,
  time: number | undefined,
): string {
  return url.replace(
    VERSIONED_URL_PART_PATTERN,
    "|" + formatVersionedUrlPart(time),
  );
}

/**
 * The kvstore part of a data source URL, up to and including its `versioned:`
 * part, e.g. `gs://b/layer/|versioned:@T/` from
 * `gs://b/layer/|versioned:@T/|neuroglancer-precomputed:`.
 */
export function getVersionedKvStoreUrl(url: string): string | undefined {
  const match = url.match(VERSIONED_URL_PART_PATTERN);
  if (match === null) return undefined;
  const end = url.indexOf("|", match.index! + 1);
  return end === -1 ? url : url.substring(0, end);
}

// Buckets whose object versions the `versioned:` adapter can list and read.
const BUCKET_URL_PATTERN = /^(?:gs|gs\+[a-z0-9+.-]+|s3|s3\+https?):\/\/[^|]+$/;
const PRECOMPUTED_LEGACY_PREFIX = "precomputed://";
const PRECOMPUTED_PIPELINE_SUFFIX = "|neuroglancer-precomputed:";

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/**
 * Bucket directory of a precomputed data source read without the `versioned:`
 * adapter: `gs://b/layer/` from `precomputed://gs://b/layer` or
 * `gs://b/layer/|neuroglancer-precomputed:`. `undefined` for anything else
 * (other formats, http(s), local, graphene, …).
 */
function plainPrecomputedBucketUrl(url: string): string | undefined {
  let bucketUrl: string | undefined;
  if (url.startsWith(PRECOMPUTED_LEGACY_PREFIX)) {
    bucketUrl = url.substring(PRECOMPUTED_LEGACY_PREFIX.length);
  } else if (url.endsWith(PRECOMPUTED_PIPELINE_SUFFIX)) {
    bucketUrl = url.substring(
      0,
      url.length - PRECOMPUTED_PIPELINE_SUFFIX.length,
    );
  }
  if (bucketUrl === undefined || !BUCKET_URL_PATTERN.test(bucketUrl)) {
    return undefined;
  }
  return withTrailingSlash(bucketUrl);
}

/**
 * Whether a time can be chosen for this data source: it already reads through
 * `versioned:`, or it is a precomputed layer in a GCS/S3 bucket (the adapter
 * is then added when a time is chosen).
 */
export function canChooseVersionTime(url: string): boolean {
  return isVersionedUrl(url) || plainPrecomputedBucketUrl(url) !== undefined;
}

/**
 * Data source URL showing the data at `time`, or current data for
 * `undefined`. Choosing a time adds the `versioned:` adapter; clearing it
 * removes the adapter again, so a layer with no time chosen has its plain URL
 * (and stays editable). A plain precomputed URL comes back in the short
 * `precomputed://bucket/path` form. URLs a time cannot be chosen for are
 * returned as is.
 */
export function chooseVersionTimeInUrl(
  url: string,
  time: number | undefined,
): string {
  const match = url.match(VERSIONED_URL_PART_PATTERN);
  if (match !== null) {
    if (time !== undefined) return setVersionTimeInUrl(url, time);
    const withoutAdapter =
      url.substring(0, match.index!) +
      url.substring(match.index! + match[0].length);
    const bucketUrl = plainPrecomputedBucketUrl(withoutAdapter);
    return bucketUrl === undefined
      ? withoutAdapter
      : PRECOMPUTED_LEGACY_PREFIX + bucketUrl.replace(/\/$/, "");
  }
  const bucketUrl = plainPrecomputedBucketUrl(url);
  if (bucketUrl === undefined || time === undefined) return url;
  return (
    bucketUrl + "|" + formatVersionedUrlPart(time) + PRECOMPUTED_PIPELINE_SUFFIX
  );
}

/**
 * The `versioned:` kvstore for a data source, with no time chosen, e.g.
 * `gs://b/layer/|versioned:` for `precomputed://gs://b/layer`. `undefined`
 * when a time cannot be chosen for it.
 */
export function versionedKvStoreUrlOf(url: string): string | undefined {
  const existing = getVersionedKvStoreUrl(url);
  if (existing !== undefined) return setVersionTimeInUrl(existing, undefined);
  const bucketUrl = plainPrecomputedBucketUrl(url);
  return bucketUrl === undefined
    ? undefined
    : bucketUrl + "|" + formatVersionedUrlPart(undefined);
}
