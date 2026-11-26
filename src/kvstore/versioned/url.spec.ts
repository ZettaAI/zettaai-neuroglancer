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
import { parsePipelineUrlComponent } from "#src/kvstore/url.js";
import {
  formatVersionTime,
  canChooseVersionTime,
  chunkUrlAtVersionTime,
  dataSourceUrlAtVersionTime,
  getVersionedKvStoreUrl,
  isVersionedUrl,
  parseVersionTime,
  parseVersionedUrl,
  setVersionTimeInUrl,
  versionedKvStoreUrlOf,
} from "#src/kvstore/versioned/url.js";

const TIME = Date.UTC(2026, 10, 10, 12, 0, 0);

describe("version time", () => {
  test("parse and format", () => {
    expect(parseVersionTime("2026-11-10T12:00:00Z")).toBe(TIME);
    expect(parseVersionTime("2026-11-10T12:00:00.250Z")).toBe(TIME + 250);
    expect(formatVersionTime(TIME)).toBe("2026-11-10T12:00:00Z");
    expect(formatVersionTime(TIME + 250)).toBe("2026-11-10T12:00:00.250Z");
  });

  test.for([
    "yesterday",
    "2026-11-10",
    "2026-11-10T12:00:00",
    "2026-13-40T12:00:00Z",
  ])("rejects %s", (timestamp) => {
    expect(() => parseVersionTime(timestamp)).toThrow("Invalid version time");
  });
});

describe("adapter url part", () => {
  function parse(part: string) {
    return parseVersionedUrl(parsePipelineUrlComponent(part));
  }

  test("no time", () => {
    expect(parse("versioned:")).toEqual({ time: undefined, path: "" });
    expect(parse("versioned:a/b")).toEqual({ time: undefined, path: "a/b" });
  });

  test("time with and without path", () => {
    expect(parse("versioned:@2026-11-10T12:00:00Z")).toEqual({
      time: TIME,
      path: "",
    });
    expect(parse("versioned:@2026-11-10T12:00:00Z/a%40b")).toEqual({
      time: TIME,
      path: "a@b",
    });
  });

  test("invalid time", () => {
    expect(() => parse("versioned:@bad/")).toThrow("Invalid URL");
  });
});

describe("pipeline url", () => {
  const live = "gs://b/layer/|versioned:|neuroglancer-precomputed:";
  const past =
    "gs://b/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:";

  test("detects the versioned part", () => {
    expect(isVersionedUrl(live)).toBe(true);
    expect(isVersionedUrl(past)).toBe(true);
    expect(isVersionedUrl("gs://b/layer/|neuroglancer-precomputed:")).toBe(
      false,
    );
    expect(isVersionedUrl("gs://b/versioned:/|zarr:")).toBe(false);
  });

  test("sets and clears the time", () => {
    expect(setVersionTimeInUrl(live, TIME)).toBe(past);
    expect(setVersionTimeInUrl(past, undefined)).toBe(live);
    expect(setVersionTimeInUrl(past, TIME + 1000)).toBe(
      "gs://b/layer/|versioned:@2026-11-10T12:00:01Z/|neuroglancer-precomputed:",
    );
  });

  test("keeps a path after the versioned part", () => {
    const url = "gs://b/|versioned:layer/|neuroglancer-precomputed:";
    const withTime = setVersionTimeInUrl(url, TIME);
    expect(withTime).toBe(
      "gs://b/|versioned:@2026-11-10T12:00:00Z/layer/|neuroglancer-precomputed:",
    );
    expect(setVersionTimeInUrl(withTime, undefined)).toBe(url);
  });

  test("time without trailing slash at the end", () => {
    expect(
      setVersionTimeInUrl(
        "gs://b/layer/|versioned:@2026-11-10T12:00:00Z",
        undefined,
      ),
    ).toBe("gs://b/layer/|versioned:");
  });

  test("url without versioned part is unchanged", () => {
    const url = "gs://b/layer/|neuroglancer-precomputed:";
    expect(setVersionTimeInUrl(url, TIME)).toBe(url);
  });
});

test("kvstore part of a data source url", () => {
  expect(
    getVersionedKvStoreUrl(
      "gs://b/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:",
    ),
  ).toBe("gs://b/layer/|versioned:@2026-11-10T12:00:00Z/");
  expect(getVersionedKvStoreUrl("gs://b/|versioned:layer/")).toBe(
    "gs://b/|versioned:layer/",
  );
  expect(getVersionedKvStoreUrl("gs://b/layer/|zarr:")).toBeUndefined();
});

describe("bucket sources a time can be chosen for", () => {
  const LEGACY = "precomputed://gs://b/layer";
  const PIPELINE = "gs://b/layer/|neuroglancer-precomputed:";
  const AT_TIME =
    "gs://b/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:";

  test("bucket precomputed sources can get a time; others cannot", () => {
    for (const url of [
      LEGACY,
      PIPELINE,
      AT_TIME,
      "precomputed://s3://b/layer",
      "precomputed://s3+https://s3.example.com/b/layer",
      "gs+ngauth+https://ngauth.example.com/b/layer/|neuroglancer-precomputed:",
    ]) {
      expect(canChooseVersionTime(url), url).toBe(true);
    }
    for (const url of [
      "precomputed://https://example.com/layer",
      "local://annotations",
      "graphene://https://example.com/segmentation",
      "zarr://gs://b/array",
      "gs://b/data.zip|zip:|neuroglancer-precomputed:",
    ]) {
      expect(canChooseVersionTime(url), url).toBe(false);
    }
  });

  test("versioned kvstore of a source, with no time", () => {
    expect(versionedKvStoreUrlOf(LEGACY)).toBe("gs://b/layer/|versioned:");
    expect(versionedKvStoreUrlOf(AT_TIME)).toBe("gs://b/layer/|versioned:");
    expect(
      versionedKvStoreUrlOf("precomputed://https://example.com/layer"),
    ).toBeUndefined();
  });
});

describe("chunkUrlAtVersionTime", () => {
  const time = Date.UTC(2026, 10, 10, 12, 0, 0);
  test.for([
    [
      "gs://b/layer/8_8_40/",
      "gs://b/layer/8_8_40/|versioned:@2026-11-10T12:00:00Z/",
    ],
    [
      "s3://b/layer/mesh/",
      "s3://b/layer/mesh/|versioned:@2026-11-10T12:00:00Z/",
    ],
  ])("%s is read at the time", ([url, expected]) => {
    expect(chunkUrlAtVersionTime(url, time)).toBe(expected);
  });

  test.for([
    // Not a bucket with object versions.
    "https://example.com/layer/8_8_40/",
    // Already read through a pipeline (e.g. `versioned:` written by hand).
    "gs://b/layer/|versioned:@2026-01-01T00:00:00Z/8_8_40/",
  ])("%s is left as it is", (url) => {
    expect(chunkUrlAtVersionTime(url, time)).toBe(url);
  });

  test("no time: latest data", () => {
    expect(chunkUrlAtVersionTime("gs://b/layer/8_8_40/", undefined)).toBe(
      "gs://b/layer/8_8_40/",
    );
  });
});

describe("dataSourceUrlAtVersionTime", () => {
  const time = Date.UTC(2026, 10, 10, 12, 0, 0);
  test.for([
    [
      "precomputed://gs://b/layer",
      "gs://b/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:",
    ],
    [
      "s3://b/layer/|neuroglancer-precomputed:",
      "s3://b/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:",
    ],
    [
      "gs://b/layer/|versioned:|neuroglancer-precomputed:",
      "gs://b/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:",
    ],
    [
      "precomputed://https://example.com/layer",
      "precomputed://https://example.com/layer",
    ],
  ] as const)("%s", ([url, expected]) => {
    expect(dataSourceUrlAtVersionTime(url, time)).toBe(expected);
  });

  test("no time: unchanged", () => {
    expect(
      dataSourceUrlAtVersionTime("precomputed://gs://b/layer", undefined),
    ).toBe("precomputed://gs://b/layer");
  });
});
