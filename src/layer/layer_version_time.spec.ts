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
import { registerSiblingAtVersionTime } from "#src/kvstore/versioned/version_time_source.js";
import {
  requestChunksAtNewVersionTime,
  sourceAtLayerVersionTime,
  TrackableVersionTime,
} from "#src/layer/layer_version_time.js";
import type { RenderLayer } from "#src/renderlayer.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

const TIME = Date.UTC(2026, 10, 19, 9, 9, 1);

describe("layer JSON", () => {
  test("saved as a time string; latest data is not saved", () => {
    const versionTime = new TrackableVersionTime();
    expect(versionTime.toJSON()).toBeUndefined();
    versionTime.value = TIME;
    expect(versionTime.toJSON()).toBe("2026-11-19T09:09:01Z");
  });

  test("restored from a share link", () => {
    const versionTime = new TrackableVersionTime();
    versionTime.restoreState("2026-11-19T09:09:01Z");
    expect(versionTime.value).toBe(TIME);
    versionTime.restoreState(undefined);
    expect(versionTime.value).toBeUndefined();
  });

  test.for([["yesterday"], [1763543341000], [null]])(
    "invalid %j opens the latest data",
    ([json]) => {
      const versionTime = new TrackableVersionTime();
      versionTime.value = TIME;
      versionTime.restoreState(json);
      expect(versionTime.value).toBeUndefined();
    },
  );
});

test("volume render layers re-request their chunks; others are left alone", () => {
  const volume = { transform: { changed: new NullarySignal() } };
  let requests = 0;
  volume.transform.changed.add(() => ++requests);
  requestChunksAtNewVersionTime([
    volume as unknown as RenderLayer,
    {} as unknown as RenderLayer,
  ]);
  expect(requests).toBe(1);
});

describe("mesh, skeleton and annotation sources", () => {
  class Source extends RefCounted {
    constructor(public time: number | undefined) {
      super();
    }
  }

  test("a past time uses the sibling at that time, kept alive by the owner", () => {
    const loaded = new Source(undefined);
    const sibling = new Source(TIME);
    registerSiblingAtVersionTime(loaded, (time) => {
      expect(time).toBe(TIME);
      return sibling;
    });
    const owner = new RefCounted();
    expect(sourceAtLayerVersionTime(loaded, TIME, owner)).toBe(sibling);
    expect(sibling.wasDisposed).toBeFalsy();
    owner.dispose();
    expect(sibling.wasDisposed).toBe(true);
    expect(loaded.wasDisposed).toBeFalsy();
  });

  test("latest data, or a source that cannot read the past: the loaded source", () => {
    const loaded = new Source(undefined);
    registerSiblingAtVersionTime(loaded, () => new Source(TIME));
    const owner = new RefCounted();
    expect(sourceAtLayerVersionTime(loaded, undefined, owner)).toBe(loaded);
    const other = new Source(undefined);
    expect(sourceAtLayerVersionTime(other, TIME, owner)).toBe(other);
    owner.dispose();
    expect(loaded.wasDisposed).toBeFalsy();
    expect(other.wasDisposed).toBeFalsy();
  });
});
