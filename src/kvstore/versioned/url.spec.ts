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
  chooseVersionTimeInUrl,
  getVersionedKvStoreUrl,
  getVersionTimeFromUrl,
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

  test("reads the time", () => {
    expect(getVersionTimeFromUrl(live)).toBeUndefined();
    expect(getVersionTimeFromUrl(past)).toBe(TIME);
    expect(getVersionTimeFromUrl("gs://b/layer/")).toBeUndefined();
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

describe("choosing a time adds and removes the adapter", () => {
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

  test("a time turns the short precomputed:// form into a versioned url", () => {
    expect(chooseVersionTimeInUrl(LEGACY, TIME)).toBe(AT_TIME);
    expect(chooseVersionTimeInUrl(PIPELINE, TIME)).toBe(AT_TIME);
  });

  test("clearing the time restores the plain short form (editable)", () => {
    expect(chooseVersionTimeInUrl(AT_TIME, undefined)).toBe(LEGACY);
    expect(
      chooseVersionTimeInUrl(
        "gs://b/layer/|versioned:|neuroglancer-precomputed:",
        undefined,
      ),
    ).toBe(LEGACY);
    expect(
      chooseVersionTimeInUrl(
        "gs://b/|versioned:@2026-11-10T12:00:00Z/dir/layer/|neuroglancer-precomputed:",
        undefined,
      ),
    ).toBe("precomputed://gs://b/dir/layer");
  });

  test("changing the time keeps the versioned url; plain stays plain", () => {
    expect(chooseVersionTimeInUrl(AT_TIME, TIME + 1000)).toBe(
      "gs://b/layer/|versioned:@2026-11-10T12:00:01Z/|neuroglancer-precomputed:",
    );
    expect(chooseVersionTimeInUrl(LEGACY, undefined)).toBe(LEGACY);
    expect(
      chooseVersionTimeInUrl("precomputed://https://example.com/layer", TIME),
    ).toBe("precomputed://https://example.com/layer");
  });

  test("versioned kvstore of a source, with no time", () => {
    expect(versionedKvStoreUrlOf(LEGACY)).toBe("gs://b/layer/|versioned:");
    expect(versionedKvStoreUrlOf(AT_TIME)).toBe("gs://b/layer/|versioned:");
    expect(
      versionedKvStoreUrlOf("precomputed://https://example.com/layer"),
    ).toBeUndefined();
  });
});
