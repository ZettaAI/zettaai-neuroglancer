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
 * Picks which stored version of one object was live at a given time, on a
 * bucket with object versioning (GCS object versioning, S3 bucket versioning).
 *
 * Every store converts its own listing into `ObjectVersionLifetime`s; the
 * selection rule below is shared.
 */

/** One stored version of an object and the time span it was the live one. */
export interface ObjectVersionLifetime {
  /** Store-specific id used to read this version (GCS generation, S3 VersionId). */
  versionId: string;
  /** Milliseconds since the epoch when this version became live. */
  liveFrom: number;
  /** Milliseconds since the epoch when it stopped being live; `undefined` = still live. */
  liveUntil: number | undefined;
  /**
   * Breaks ties between versions that became live in the same millisecond:
   * the larger value is the newer write.
   */
  writeOrder: bigint;
}

function isLiveAt(lifetime: ObjectVersionLifetime, time: number) {
  return (
    lifetime.liveFrom <= time &&
    (lifetime.liveUntil === undefined || time < lifetime.liveUntil)
  );
}

function isNewerWrite(
  candidate: ObjectVersionLifetime,
  current: ObjectVersionLifetime,
) {
  if (candidate.liveFrom !== current.liveFrom) {
    return candidate.liveFrom > current.liveFrom;
  }
  return candidate.writeOrder > current.writeOrder;
}

/**
 * Returns the version that was live at `time`, or `undefined` if the object did
 * not exist at that time. Never falls back to the current version.
 */
export function versionLiveAt(
  lifetimes: readonly ObjectVersionLifetime[],
  time: number,
): ObjectVersionLifetime | undefined {
  let live: ObjectVersionLifetime | undefined;
  for (const lifetime of lifetimes) {
    if (!isLiveAt(lifetime, time)) continue;
    if (live === undefined || isNewerWrite(lifetime, live)) {
      live = lifetime;
    }
  }
  return live;
}

/** Earliest time any version of the object was live, or `undefined` without history. */
export function earliestLiveTime(
  lifetimes: readonly ObjectVersionLifetime[],
): number | undefined {
  let earliest: number | undefined;
  for (const { liveFrom } of lifetimes) {
    if (earliest === undefined || liveFrom < earliest) earliest = liveFrom;
  }
  return earliest;
}

/** One GCS object generation, as returned by `objects.list?versions=true`. */
export interface GcsObjectGeneration {
  generation: string;
  timeCreated: number;
  /** Set once the generation became noncurrent (overwritten or deleted). */
  timeDeleted: number | undefined;
}

/**
 * GCS: a generation is live from `timeCreated` until `timeDeleted`.
 * `updated` (metadata changes) is irrelevant; generation only breaks ties.
 */
export function gcsGenerationLifetimes(
  generations: readonly GcsObjectGeneration[],
): ObjectVersionLifetime[] {
  return generations.map(({ generation, timeCreated, timeDeleted }) => ({
    versionId: generation,
    liveFrom: timeCreated,
    liveUntil: timeDeleted,
    writeOrder: BigInt(generation),
  }));
}

/**
 * One S3 version entry for a single key, as returned by `ListObjectVersions`
 * (both `Version` and `DeleteMarker` elements).
 */
export interface S3ObjectVersionEntry {
  versionId: string;
  lastModified: number;
  isDeleteMarker: boolean;
}

/**
 * S3 `LastModified` is truncated to whole seconds. A version written at
 * 12:00:00.700 is listed as 12:00:00, so it is treated as live only from the
 * end of that second: data written after a chosen time is never shown, at the
 * cost of showing the previous version for up to one second after a write.
 * Times with sub-second precision (some S3-compatible servers) are used as is.
 */
export function s3EffectiveWriteTime(lastModified: number) {
  return lastModified % 1000 === 0 ? lastModified + 999 : lastModified;
}

/**
 * S3 records only when each version (or delete marker) was written; a version
 * stays live until the next newer entry. `entries` must be in S3 listing order
 * for the key (newest first), which is the only reliable order when several
 * writes share the same `LastModified` second.
 */
export function s3VersionLifetimes(
  entries: readonly S3ObjectVersionEntry[],
): ObjectVersionLifetime[] {
  const lifetimes: ObjectVersionLifetime[] = [];
  let newerEntryTime: number | undefined;
  entries.forEach((entry, listIndex) => {
    const writeTime = s3EffectiveWriteTime(entry.lastModified);
    if (!entry.isDeleteMarker) {
      lifetimes.push({
        versionId: entry.versionId,
        liveFrom: writeTime,
        liveUntil: newerEntryTime,
        writeOrder: BigInt(entries.length - listIndex),
      });
    }
    newerEntryTime =
      newerEntryTime === undefined
        ? writeTime
        : Math.min(newerEntryTime, writeTime);
  });
  return lifetimes;
}
