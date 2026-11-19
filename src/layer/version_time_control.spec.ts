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
import type { LayerDataSource } from "#src/layer/layer_data_source.js";
import { TrackableVersionTime } from "#src/layer/layer_version_time.js";
import {
  firstVersionedDataSource,
  getLayerVersionTime,
  makeVersionTimeState,
  setLayerVersionTime,
  startOfLocalDay,
  watchHostsVersionTime,
} from "#src/layer/version_time_control.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

const TIME = Date.UTC(2026, 10, 10, 12, 0, 0);
// A bucket precomputed layer. Its URL stays the same at every time: the
// chosen time is layer state of its own (`versionTime`).
const CURRENT = "precomputed://gs://b/layer";
// Same layer read through the `versioned:` adapter, written by hand.
const LIVE = "gs://b/layer/|versioned:|neuroglancer-precomputed:";
// No time can be chosen for a source outside a GCS/S3 bucket.
const NOT_BUCKET = "precomputed://https://example.com/other";

class FakeDataSource {
  specAssignments = 0;
  constructor(
    public layer: FakeLayer,
    private spec_: { url: string; setManually?: boolean },
  ) {}
  asLayerDataSource() {
    return this as unknown as LayerDataSource;
  }
  get spec() {
    return this.spec_;
  }
  set spec(spec: { url: string; setManually?: boolean }) {
    this.spec_ = spec;
    ++this.specAssignments;
    this.layer.dataSourcesChanged.dispatch();
  }
}

class FakeLayer extends RefCounted {
  dataSourcesChanged = new NullarySignal();
  versionTime = new TrackableVersionTime();
  /** Times applied to the layer (each re-requests its chunks). */
  appliedTimes: (number | undefined)[] = [];
  dataSources: FakeDataSource[];
  sessionLocked = false;
  managedLayer = {
    name: "layer",
    manager: {
      root: {
        editSessionHost: {
          sessionLock: {
            isSessionLayer: () => this.sessionLocked,
          },
        },
      },
    },
  };
  earliestTimeLookups = 0;
  manager = {
    dataSourceProviderRegistry: {
      sharedKvStoreContext: {
        kvStoreContext: {
          getKvStore: () => {
            ++this.earliestTimeLookups;
            throw new Error("no kvstore in this test");
          },
        },
      },
    },
  };
  constructor(urls: string[], time?: number) {
    super();
    this.dataSources = urls.map((url) => new FakeDataSource(this, { url }));
    this.versionTime.value = time;
    this.versionTime.changed.add(() =>
      this.appliedTimes.push(this.versionTime.value),
    );
  }
  asUserLayer() {
    return this as unknown as UserLayer;
  }
  get urls() {
    return this.dataSources.map(({ spec }) => spec.url);
  }
  get specAssignments() {
    return this.dataSources.map((dataSource) => dataSource.specAssignments);
  }
}

describe("layer version time", () => {
  test("is the layer's own time, not read from the urls", () => {
    expect(getLayerVersionTime(new FakeLayer([LIVE]).asUserLayer())).toBe(
      undefined,
    );
    expect(
      getLayerVersionTime(
        new FakeLayer([NOT_BUCKET, CURRENT], TIME).asUserLayer(),
      ),
    ).toBe(TIME);
  });

  test("choosing and clearing a time never changes a data source url", () => {
    const layer = new FakeLayer([CURRENT, NOT_BUCKET]);
    setLayerVersionTime(layer.asUserLayer(), TIME);
    expect(layer.versionTime.value).toBe(TIME);
    setLayerVersionTime(layer.asUserLayer(), undefined);
    expect(layer.versionTime.value).toBeUndefined();
    expect(layer.urls).toEqual([CURRENT, NOT_BUCKET]);
    expect(layer.specAssignments).toEqual([0, 0]);
  });

  test("same time is not applied again", () => {
    const layer = new FakeLayer([CURRENT], TIME);
    setLayerVersionTime(layer.asUserLayer(), TIME);
    expect(layer.appliedTimes).toEqual([]);
  });

  test("picker is hosted under the first versioned source only", () => {
    const layer = new FakeLayer([NOT_BUCKET, CURRENT, LIVE]);
    const [plain, first, second] = layer.dataSources;
    expect(firstVersionedDataSource(layer.asUserLayer())).toBe(first);
    expect(watchHostsVersionTime(plain.asLayerDataSource()).value).toBe(false);
    expect(watchHostsVersionTime(first.asLayerDataSource()).value).toBe(true);
    expect(watchHostsVersionTime(second.asLayerDataSource()).value).toBe(false);
    plain.spec = { url: LIVE };
    expect(watchHostsVersionTime(plain.asLayerDataSource()).value).toBe(true);
  });

  test("choosing a time does not rebuild the picker (keeps typing focus)", () => {
    const layer = new FakeLayer([CURRENT]);
    const hosts = watchHostsVersionTime(
      layer.dataSources[0].asLayerDataSource(),
    );
    let signals = 0;
    hosts.changed.add(() => ++signals);
    setLayerVersionTime(layer.asUserLayer(), TIME);
    setLayerVersionTime(layer.asUserLayer(), TIME + 1000);
    setLayerVersionTime(layer.asUserLayer(), undefined);
    expect(signals).toBe(0);
    layer.dataSources[0].spec = { url: NOT_BUCKET };
    expect(signals).toBe(1);
    expect(hosts.value).toBe(false);
  });
});

describe("picker state", () => {
  test("picking a time sets the layer time; clearing returns to the latest data", () => {
    const layer = new FakeLayer([CURRENT]);
    const context = new RefCounted();
    const { intermediateTimestamp } = makeVersionTimeState(
      layer.asUserLayer(),
      context,
    );
    expect(intermediateTimestamp.value).toBeUndefined();
    intermediateTimestamp.value = TIME;
    expect(layer.versionTime.value).toBe(TIME);
    intermediateTimestamp.value = undefined;
    expect(layer.versionTime.value).toBeUndefined();
    expect(layer.urls).toEqual([CURRENT]);
    expect(layer.specAssignments).toEqual([0]);
    context.dispose();
  });

  test("typing a time is applied once, on Enter or leaving the field", () => {
    const layer = new FakeLayer([CURRENT]);
    const context = new RefCounted();
    const { intermediateTimestamp, startTyping, finishTyping } =
      makeVersionTimeState(layer.asUserLayer(), context);
    startTyping();
    // Half-typed values, as the picker reports them keystroke by keystroke.
    intermediateTimestamp.value = TIME - 3600_000;
    intermediateTimestamp.value = TIME - 60_000;
    intermediateTimestamp.value = TIME;
    expect(layer.appliedTimes).toEqual([]);
    finishTyping();
    expect(layer.appliedTimes).toEqual([TIME]);
    context.dispose();
  });

  test("after Enter the field still holds further typing until applied", () => {
    const layer = new FakeLayer([CURRENT]);
    const context = new RefCounted();
    const { intermediateTimestamp, startTyping, applyTypedTime, finishTyping } =
      makeVersionTimeState(layer.asUserLayer(), context);
    startTyping();
    intermediateTimestamp.value = TIME;
    applyTypedTime();
    expect(layer.appliedTimes).toEqual([TIME]);
    intermediateTimestamp.value = TIME - 3600_000;
    expect(layer.appliedTimes).toEqual([TIME]);
    finishTyping();
    expect(layer.appliedTimes).toEqual([TIME, TIME - 3600_000]);
    context.dispose();
  });

  test("leaving the field without a change does not apply anything", () => {
    const layer = new FakeLayer([CURRENT], TIME);
    const context = new RefCounted();
    const { startTyping, finishTyping } = makeVersionTimeState(
      layer.asUserLayer(),
      context,
    );
    startTyping();
    finishTyping();
    expect(layer.appliedTimes).toEqual([]);
    context.dispose();
  });

  test("follows time changes made elsewhere (state, share link)", () => {
    const layer = new FakeLayer([CURRENT]);
    const context = new RefCounted();
    const { intermediateTimestamp } = makeVersionTimeState(
      layer.asUserLayer(),
      context,
    );
    layer.versionTime.value = TIME;
    expect(intermediateTimestamp.value).toBe(TIME);
    expect(layer.appliedTimes).toEqual([TIME]);
    context.dispose();
  });

  test("layer locked by an edit session keeps its time", () => {
    const layer = new FakeLayer([CURRENT]);
    layer.sessionLocked = true;
    const context = new RefCounted();
    const { intermediateTimestamp } = makeVersionTimeState(
      layer.asUserLayer(),
      context,
    );
    intermediateTimestamp.value = TIME;
    expect(intermediateTimestamp.value).toBeUndefined();
    expect(layer.versionTime.value).toBeUndefined();
    expect(layer.appliedTimes).toEqual([]);
    context.dispose();
  });

  test("unknown earliest time leaves the picker without a limit", async () => {
    const layer = new FakeLayer([CURRENT]);
    const context = new RefCounted();
    const { timestampLimit } = makeVersionTimeState(
      layer.asUserLayer(),
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timestampLimit.value).toBe(0);
    context.dispose();
  });

  test("bucket history is looked up again only when the layer changes", () => {
    const layer = new FakeLayer([CURRENT]);
    const context = new RefCounted();
    makeVersionTimeState(layer.asUserLayer(), context);
    // One lookup = two kvstore requests: history check + earliest time.
    expect(layer.earliestTimeLookups).toBe(2);
    // Choosing a time reads the same layer: no new lookup.
    setLayerVersionTime(layer.asUserLayer(), TIME);
    expect(layer.earliestTimeLookups).toBe(2);
    layer.dataSources[0].spec = { url: "precomputed://gs://b/other" };
    expect(layer.earliestTimeLookups).toBe(4);
    context.dispose();
  });
});

test("history check failing for another reason leaves the picker usable", async () => {
  const layer = new FakeLayer([CURRENT]);
  const context = new RefCounted();
  const { historyStatus } = makeVersionTimeState(layer.asUserLayer(), context);
  // The fake kvstore throws: nothing can be listed, and it is not a
  // permission answer, so "unknown" right away (no request to wait for).
  expect(historyStatus.value).toBe("unknown");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(historyStatus.value).toBe("unknown");
  context.dispose();
});

test("earliest selectable time is the start of that local day", () => {
  const afternoon = new Date(2026, 10, 17, 15, 30, 12).valueOf();
  expect(startOfLocalDay(afternoon)).toBe(
    new Date(2026, 10, 17, 0, 0, 0).valueOf(),
  );
  expect(startOfLocalDay(0)).toBe(0);
});
