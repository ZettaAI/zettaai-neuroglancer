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

import { beforeEach, describe, expect, test } from "vitest";
import {
  CLOCK_SKEW_MARGIN_MS,
  ObjectVersionHistoryCache,
  RELIST_INTERVAL_MS,
} from "#src/kvstore/versioned/object_version_history_cache.js";
import type { ObjectVersionLifetime } from "#src/kvstore/versioned/version_at_time.js";

const HOUR = 3600 * 1000;

let now: number;
let listings: number;
let cache: ObjectVersionHistoryCache;

async function listObjectVersions(): Promise<ObjectVersionLifetime[]> {
  ++listings;
  return [];
}

function get(objectUrl: string, time: number | undefined) {
  return cache.get(objectUrl, time, listObjectVersions, {});
}

beforeEach(() => {
  now = 10 * HOUR;
  listings = 0;
  cache = new ObjectVersionHistoryCache(() => now);
});

describe("object version history cache", () => {
  test("one listing per object for times well before the listing", async () => {
    await get("a", now - HOUR);
    now += HOUR;
    await get("a", now - 3 * HOUR);
    await get("a", undefined);
    expect(listings).toBe(1);
    await get("b", now - HOUR);
    expect(listings).toBe(2);
  });

  test("concurrent requests share one listing", async () => {
    await Promise.all([get("a", now - HOUR), get("a", now - HOUR)]);
    expect(listings).toBe(1);
  });

  test("time later than the listing is relisted", async () => {
    const listedAt = now;
    await get("a", listedAt - HOUR);
    now += HOUR;
    // Writes between the listing and this time are not in the cached history.
    await get("a", listedAt + 30 * 60 * 1000);
    expect(listings).toBe(2);
    // The new listing was made long enough after that time: trusted.
    now += RELIST_INTERVAL_MS + CLOCK_SKEW_MARGIN_MS;
    await get("a", listedAt + 30 * 60 * 1000);
    expect(listings).toBe(2);
  });

  test("time within the clock skew margin is relisted at most every interval", async () => {
    await get("a", now - 1000);
    await get("a", now - 1000);
    expect(listings).toBe(1);
    now += RELIST_INTERVAL_MS;
    await get("a", now - 1000);
    expect(listings).toBe(2);
  });

  test("failed listing is not cached", async () => {
    let fail = true;
    const flaky = async () => {
      ++listings;
      if (fail) throw new Error("network");
      return [];
    };
    await expect(cache.get("a", now - HOUR, flaky, {})).rejects.toThrow(
      "network",
    );
    fail = false;
    await cache.get("a", now - HOUR, flaky, {});
    expect(listings).toBe(2);
  });
});
