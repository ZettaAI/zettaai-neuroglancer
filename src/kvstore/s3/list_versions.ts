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

import {
  EARLIER_VERSIONS_PAGE_SIZE,
  parseListingTime,
} from "#src/kvstore/versioned/object_version_store.js";
import type {
  ObjectVersionLifetime,
  S3ObjectVersionEntry,
} from "#src/kvstore/versioned/version_at_time.js";
import { s3VersionLifetimes } from "#src/kvstore/versioned/version_at_time.js";
import type { FetchOk } from "#src/util/http_request.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

interface ListedVersion extends S3ObjectVersionEntry {
  isLatest: boolean;
  listIndex: number;
}

/** Decodes a key from an `encoding-type=url` listing (spaces arrive as `+`). */
function decodeListedKey(encoded: string): string {
  return decodeURIComponent(encoded.replaceAll("+", " "));
}

// Version listings are read in the chunk worker, where `DOMParser` does not
// exist. `ListVersionsResult` is flat (no nesting beyond one level of
// elements, no attributes needed), so a small tag reader is enough.

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (match, entity) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

/** Text of the first `<name>` element directly in `xml`, if present. */
function childText(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (match === null) {
    return new RegExp(`<${name}\\s*/>`).test(xml) ? "" : undefined;
  }
  return decodeXmlText(match[1]);
}

function requiredChildText(xml: string, elementName: string, name: string) {
  const text = childText(xml, name);
  if (text === undefined) {
    throw new Error(`<${elementName}> without <${name}>`);
  }
  return text;
}

interface ListVersionsPage {
  versions: ListedVersion[];
  /** A later key appeared: listings are sorted by key, so `key` is complete. */
  passedKey: boolean;
  nextMarkers: { keyMarker: string; versionIdMarker: string } | undefined;
}

function parseListVersionsPage(
  text: string,
  key: string,
  firstListIndex: number,
): ListVersionsPage {
  if (!/<ListVersionsResult[\s>]/.test(text)) {
    throw new Error(
      `Expected a ListVersionsResult, received: ${text.slice(0, 100)}`,
    );
  }
  const versions: ListedVersion[] = [];
  let passedKey = false;
  const entryPattern = /<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g;
  for (const [, elementName, entry] of text.matchAll(entryPattern)) {
    const isDeleteMarker = elementName === "DeleteMarker";
    const listedKey = decodeListedKey(
      requiredChildText(entry, elementName, "Key"),
    );
    if (listedKey !== key) {
      // `prefix` also matches longer keys, which sort after `key`.
      passedKey = true;
      continue;
    }
    versions.push({
      versionId: requiredChildText(entry, elementName, "VersionId"),
      lastModified: parseListingTime(
        requiredChildText(entry, elementName, "LastModified"),
      ),
      isDeleteMarker,
      isLatest: childText(entry, "IsLatest") === "true",
      listIndex: firstListIndex + versions.length,
    });
  }
  // Result-level fields, outside the entries.
  const summary = text.replace(entryPattern, "");
  const isTruncated = childText(summary, "IsTruncated") === "true";
  return {
    versions,
    passedKey,
    nextMarkers: isTruncated
      ? {
          keyMarker: decodeListedKey(
            requiredChildText(summary, "ListVersionsResult", "NextKeyMarker"),
          ),
          versionIdMarker: requiredChildText(
            summary,
            "ListVersionsResult",
            "NextVersionIdMarker",
          ),
        }
      : undefined,
  };
}

/**
 * Newest first. Delete markers are not reliably interleaved with versions in
 * the listing, and `LastModified` has 1 s precision, so ties go to the entry
 * marked `IsLatest`, then to listing order.
 */
function compareNewestFirst(first: ListedVersion, second: ListedVersion) {
  return (
    second.lastModified - first.lastModified ||
    Number(second.isLatest) - Number(first.isLatest) ||
    first.listIndex - second.listIndex
  );
}

/**
 * Lists every version (and delete marker) of exactly `key` with
 * `ListObjectVersions`, following pagination. `bucketUrl` is the bucket root
 * (`https://bucket.s3.amazonaws.com/` or `https://host/bucket/`).
 */
export async function listS3ObjectVersions(
  bucketUrl: string,
  key: string,
  fetchOkImpl: FetchOk,
  options: Partial<ProgressOptions>,
): Promise<ObjectVersionLifetime[]> {
  const versions: ListedVersion[] = [];
  let markers: ListVersionsPage["nextMarkers"];
  do {
    const response = await fetchOkImpl(
      `${bucketUrl}?versions&prefix=${encodeURIComponent(key)}&encoding-type=url` +
        (markers === undefined
          ? ""
          : `&key-marker=${encodeURIComponent(markers.keyMarker)}` +
            `&version-id-marker=${encodeURIComponent(markers.versionIdMarker)}`),
      {
        headers: { accept: "application/xml,text/xml" },
        signal: options.signal,
        progressListener: options.progressListener,
      },
    );
    const page = parseListVersionsPage(
      await response.text(),
      key,
      versions.length,
    );
    versions.push(...page.versions);
    markers = page.passedKey ? undefined : page.nextMarkers;
  } while (markers !== undefined);
  versions.sort(compareNewestFirst);
  return s3VersionLifetimes(versions);
}

/**
 * Whether the first `ListObjectVersions` page under `prefix` holds a
 * noncurrent version or a delete marker. `bucketUrl` as for
 * `listS3ObjectVersions`.
 */
export async function hasS3EarlierVersions(
  bucketUrl: string,
  prefix: string,
  fetchOkImpl: FetchOk,
  options: Partial<ProgressOptions>,
): Promise<boolean> {
  const response = await fetchOkImpl(
    `${bucketUrl}?versions&prefix=${encodeURIComponent(prefix)}` +
      `&max-keys=${EARLIER_VERSIONS_PAGE_SIZE}&encoding-type=url`,
    {
      headers: { accept: "application/xml,text/xml" },
      signal: options.signal,
      progressListener: options.progressListener,
    },
  );
  const text = await response.text();
  if (!/<ListVersionsResult[\s>]/.test(text)) {
    throw new Error(
      `Expected a ListVersionsResult, received: ${text.slice(0, 100)}`,
    );
  }
  return (
    /<DeleteMarker>/.test(text) ||
    /<IsLatest>\s*false\s*<\/IsLatest>/.test(text)
  );
}

export function getS3ObjectVersionUrl(objectUrl: string, versionId: string) {
  return (
    objectUrl +
    (objectUrl.includes("?") ? "&" : "?") +
    `versionId=${encodeURIComponent(versionId)}`
  );
}
