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
import type { UserLayer } from "#src/layer/index.js";
import { TrackableVersionTime } from "#src/layer/layer_version_time.js";
import { keepMetadataAtVersionTime } from "#src/layer/metadata_at_version_time.js";
import { NullarySignal } from "#src/util/signal.js";

const CURRENT = "precomputed://gs://b/layer";
const OLD_INFO_TIME = Date.UTC(2026, 10, 1);
const SAME_INFO_TIME = Date.UTC(2026, 10, 20);

/** `info` of the layer: rewritten on 2026-11-10. */
function infoAt(url: string) {
  const match = url.match(/@([^/]*)\//);
  if (match === null) return "info-v2";
  return Date.parse(match[1]) < Date.UTC(2026, 10, 10) ? "info-v1" : "info-v2";
}

class FakeDataSource {
  wasDisposed = false;
  loads: (number | undefined)[] = [];
  loadedAtVersionTime: number | undefined = undefined;
  constructor(
    private layer: FakeLayer,
    public spec: { url: string },
  ) {}
  loadAtVersionTime(time: number | undefined) {
    if (time === this.loadedAtVersionTime) return;
    this.loadedAtVersionTime = time;
    this.loads.push(time);
    // Loading again signals a data source change, as the real one does.
    this.layer.dataSourcesChanged.dispatch();
  }
}

class FakeLayer {
  versionTime = new TrackableVersionTime();
  dataSourcesChanged = new NullarySignal();
  dataSources: FakeDataSource[];
  infoReads: string[] = [];
  /** `info` reads wait for this (a slow bucket). */
  answer: Promise<void> = Promise.resolve();
  manager = {
    dataSourceProviderRegistry: {
      sharedKvStoreContext: {
        kvStoreContext: {
          read: async (url: string) => {
            this.infoReads.push(url);
            await this.answer;
            return { response: new Response(infoAt(url)) };
          },
        },
      },
    },
  };
  constructor(url: string) {
    this.dataSources = [new FakeDataSource(this, { url })];
  }
  asUserLayer() {
    return this as unknown as UserLayer;
  }
  get loads() {
    return this.dataSources[0].loads;
  }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("metadata at the layer's time", () => {
  test("info changed since that time: loaded again at that time", async () => {
    const layer = new FakeLayer(CURRENT);
    const stop = keepMetadataAtVersionTime(layer.asUserLayer());
    layer.versionTime.value = OLD_INFO_TIME;
    await settle();
    expect(layer.loads).toEqual([OLD_INFO_TIME]);
    stop();
  });

  test("same info as now: the current data source is kept", async () => {
    const layer = new FakeLayer(CURRENT);
    const stop = keepMetadataAtVersionTime(layer.asUserLayer());
    layer.versionTime.value = SAME_INFO_TIME;
    await settle();
    expect(layer.loads).toEqual([]);
    expect(layer.infoReads).toEqual([
      "gs://b/layer/|versioned:@2026-11-20T00:00:00Z/info",
      "gs://b/layer/|versioned:info",
    ]);
    stop();
  });

  test("clearing the time returns to the current data source", async () => {
    const layer = new FakeLayer(CURRENT);
    const stop = keepMetadataAtVersionTime(layer.asUserLayer());
    layer.versionTime.value = OLD_INFO_TIME;
    await settle();
    layer.versionTime.value = undefined;
    expect(layer.loads).toEqual([OLD_INFO_TIME, undefined]);
    stop();
  });

  test("loading again does not start the same check again", async () => {
    const layer = new FakeLayer(CURRENT);
    const stop = keepMetadataAtVersionTime(layer.asUserLayer());
    layer.versionTime.value = OLD_INFO_TIME;
    await settle();
    expect(layer.infoReads).toHaveLength(2);
    layer.dataSourcesChanged.dispatch();
    await settle();
    expect(layer.infoReads).toHaveLength(2);
    expect(layer.loads).toEqual([OLD_INFO_TIME]);
    stop();
  });

  test("an answer for a time no longer chosen is dropped", async () => {
    const layer = new FakeLayer(CURRENT);
    let answer = () => {};
    layer.answer = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const stop = keepMetadataAtVersionTime(layer.asUserLayer());
    layer.versionTime.value = OLD_INFO_TIME;
    layer.versionTime.value = undefined;
    answer();
    await settle();
    expect(layer.loads).toEqual([]);
    stop();
  });

  test("sources a time cannot be chosen for are never checked", async () => {
    const layer = new FakeLayer("precomputed://https://example.com/layer");
    const stop = keepMetadataAtVersionTime(layer.asUserLayer());
    layer.versionTime.value = OLD_INFO_TIME;
    await settle();
    expect(layer.infoReads).toEqual([]);
    expect(layer.loads).toEqual([]);
    stop();
  });
});
