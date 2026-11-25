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

import { describe, expect, test } from "vitest";
import type {
  GcsObjectGeneration,
  S3ObjectVersionEntry,
} from "#src/kvstore/versioned/version_at_time.js";
import {
  earliestLiveTime,
  gcsGenerationLifetimes,
  s3VersionLifetimes,
  versionLiveAt,
} from "#src/kvstore/versioned/version_at_time.js";

function gcsVersionAt(generations: GcsObjectGeneration[], time: number) {
  return versionLiveAt(gcsGenerationLifetimes(generations), time)?.versionId;
}

function s3VersionAt(entries: S3ObjectVersionEntry[], time: number) {
  return versionLiveAt(s3VersionLifetimes(entries), time)?.versionId;
}

describe("gcs generation live at time", () => {
  test("single live generation", () => {
    const history = [
      { generation: "100", timeCreated: 1000, timeDeleted: undefined },
    ];
    expect(gcsVersionAt(history, 999)).toBeUndefined();
    expect(gcsVersionAt(history, 1000)).toBe("100");
    expect(gcsVersionAt(history, 5000)).toBe("100");
  });

  test("overwrite: old generation before, new generation after", () => {
    const history = [
      { generation: "100", timeCreated: 1000, timeDeleted: 2000 },
      { generation: "200", timeCreated: 2000, timeDeleted: undefined },
    ];
    expect(gcsVersionAt(history, 1999)).toBe("100");
    expect(gcsVersionAt(history, 2000)).toBe("200");
  });

  test("deleted object is absent after deletion, present before", () => {
    const history = [
      { generation: "100", timeCreated: 1000, timeDeleted: 3000 },
    ];
    expect(gcsVersionAt(history, 2999)).toBe("100");
    expect(gcsVersionAt(history, 3000)).toBeUndefined();
  });

  test("gap between delete and re-create is absent", () => {
    const history = [
      { generation: "100", timeCreated: 1000, timeDeleted: 2000 },
      { generation: "300", timeCreated: 3000, timeDeleted: undefined },
    ];
    expect(gcsVersionAt(history, 2500)).toBeUndefined();
    expect(gcsVersionAt(history, 3500)).toBe("300");
  });

  test("time before first version is absent, never the live version", () => {
    const history = [
      { generation: "100", timeCreated: 1000, timeDeleted: undefined },
    ];
    expect(gcsVersionAt(history, 0)).toBeUndefined();
  });

  test("same-millisecond rewrites: larger generation wins", () => {
    const history = [
      {
        generation: "1000000000000002",
        timeCreated: 1000,
        timeDeleted: undefined,
      },
      {
        generation: "1000000000000001",
        timeCreated: 1000,
        timeDeleted: undefined,
      },
    ];
    expect(gcsVersionAt(history, 1000)).toBe("1000000000000002");
  });

  test("ordered by timeCreated, not by generation", () => {
    // Overlapping lifetimes (never expected, but must not depend on generation order).
    const history = [
      { generation: "900", timeCreated: 2000, timeDeleted: undefined },
      { generation: "100", timeCreated: 1000, timeDeleted: undefined },
    ];
    expect(gcsVersionAt(history, 2500)).toBe("900");
  });

  test("input order does not matter", () => {
    const history = [
      { generation: "300", timeCreated: 3000, timeDeleted: undefined },
      { generation: "100", timeCreated: 1000, timeDeleted: 2000 },
      { generation: "200", timeCreated: 2000, timeDeleted: 3000 },
    ];
    expect(gcsVersionAt(history, 1500)).toBe("100");
    expect(gcsVersionAt(history, 2500)).toBe("200");
    expect(gcsVersionAt(history, 3500)).toBe("300");
  });

  test("empty history is absent", () => {
    expect(gcsVersionAt([], 1000)).toBeUndefined();
  });
});

describe("s3 version live at time", () => {
  // S3 `LastModified` is whole seconds; a version counts as live only from
  // the end of its second (x.999), so a write later in that second is never
  // shown for an earlier time.
  test("versions newest first; each live until the next write", () => {
    const entries = [
      { versionId: "c", lastModified: 3000, isDeleteMarker: false },
      { versionId: "b", lastModified: 2000, isDeleteMarker: false },
      { versionId: "a", lastModified: 1000, isDeleteMarker: false },
    ];
    expect(s3VersionAt(entries, 500)).toBeUndefined();
    expect(s3VersionAt(entries, 1000)).toBeUndefined();
    expect(s3VersionAt(entries, 1999)).toBe("a");
    expect(s3VersionAt(entries, 2998)).toBe("a");
    expect(s3VersionAt(entries, 2999)).toBe("b");
    expect(s3VersionAt(entries, 9000)).toBe("c");
  });

  test("sub-second LastModified is used as is", () => {
    const entries = [
      { versionId: "b", lastModified: 2250, isDeleteMarker: false },
      { versionId: "a", lastModified: 1250, isDeleteMarker: false },
    ];
    expect(s3VersionAt(entries, 1250)).toBe("a");
    expect(s3VersionAt(entries, 2249)).toBe("a");
    expect(s3VersionAt(entries, 2250)).toBe("b");
  });

  test("delete marker makes the object absent", () => {
    const entries = [
      { versionId: "marker", lastModified: 2000, isDeleteMarker: true },
      { versionId: "a", lastModified: 1000, isDeleteMarker: false },
    ];
    expect(s3VersionAt(entries, 2500)).toBe("a");
    expect(s3VersionAt(entries, 2999)).toBeUndefined();
    expect(s3VersionAt(entries, 9000)).toBeUndefined();
  });

  test("re-created after delete marker", () => {
    const entries = [
      { versionId: "b", lastModified: 3000, isDeleteMarker: false },
      { versionId: "marker", lastModified: 2000, isDeleteMarker: true },
      { versionId: "a", lastModified: 1000, isDeleteMarker: false },
    ];
    expect(s3VersionAt(entries, 3500)).toBeUndefined();
    expect(s3VersionAt(entries, 3999)).toBe("b");
  });

  test("same-second writes: newest in listing order wins", () => {
    const entries = [
      { versionId: "second", lastModified: 1000, isDeleteMarker: false },
      { versionId: "first", lastModified: 1000, isDeleteMarker: false },
    ];
    expect(s3VersionAt(entries, 1999)).toBe("second");
  });

  test("'null' version id (written before versioning was enabled)", () => {
    const entries = [
      { versionId: "v2", lastModified: 2000, isDeleteMarker: false },
      { versionId: "null", lastModified: 1000, isDeleteMarker: false },
    ];
    expect(s3VersionAt(entries, 1999)).toBe("null");
  });
});

test("earliest live time", () => {
  expect(earliestLiveTime([])).toBeUndefined();
  expect(
    earliestLiveTime(
      gcsGenerationLifetimes([
        { generation: "2", timeCreated: 2000, timeDeleted: undefined },
        { generation: "1", timeCreated: 1000, timeDeleted: 2000 },
      ]),
    ),
  ).toBe(1000);
});
