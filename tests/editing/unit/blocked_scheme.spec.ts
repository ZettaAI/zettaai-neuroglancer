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
import { blockedSchemeOf } from "#src/editing/ui/layer_kind.js";
import type { ManagedUserLayer } from "#src/layer/index.js";

function managedWithUrls(...urls: string[]) {
  return {
    layer: { dataSources: urls.map((url) => ({ spec: { url } })) },
  } as unknown as ManagedUserLayer;
}

describe("blockedSchemeOf", () => {
  test.for([
    ["calcada://https://server/table", "calcada"],
    ["graphene://https://server/table", "graphene"],
    ["middleauth+https://server/layer", "middleauth"],
    [
      "gs://b/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:",
      "versioned",
    ],
    ["gs://b/|versioned:@2026-11-10T12:00:00Z/layer/", "versioned"],
    // Live, but the save path would drop the path after `versioned:`.
    ["gs://b/layer/|versioned:|neuroglancer-precomputed:", "versioned"],
    ["gs://b/|versioned:layer/|neuroglancer-precomputed:", "versioned"],
  ])("%s is blocked as %s", ([url, scheme]) => {
    expect(blockedSchemeOf(managedWithUrls(url))).toBe(scheme);
  });

  test.for([
    "gs://b/layer/|neuroglancer-precomputed:",
    "precomputed://gs://b/layer",
    "gs://b/versioned:@x/layer/",
    "zarr://https://server/versioned@2026/data.zarr",
  ])("%s is not blocked", (url) => {
    expect(blockedSchemeOf(managedWithUrls(url))).toBeUndefined();
  });

  test("any blocked source blocks the layer", () => {
    expect(
      blockedSchemeOf(
        managedWithUrls(
          "gs://b/other/|neuroglancer-precomputed:",
          "gs://b/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:",
        ),
      ),
    ).toBe("versioned");
  });

  test("no layer", () => {
    expect(blockedSchemeOf(undefined)).toBeUndefined();
  });
});
