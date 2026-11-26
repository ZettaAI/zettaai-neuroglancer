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

import "#src/kvstore/gcs/register.js";
import "#src/kvstore/http/register_frontend.js";
import "#src/kvstore/versioned/register.js";
import "#src/datasource/precomputed/register_default.js";
import { http, HttpResponse } from "msw";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  dataSourceUrlAtVersionTime,
  formatVersionTime,
} from "#src/kvstore/versioned/url.js";
import type { VersionedKvStore } from "#src/kvstore/versioned/versioned_kvstore.js";
import { metadataLoadTimeFor } from "#src/layer/metadata_at_version_time.js";
import { dataSourceProviderFixture } from "#tests/fixtures/datasource_provider.js";
import {
  createBucket,
  deleteObject,
  fakeGcsServerFixture,
  writeObject,
} from "#tests/fixtures/fake_gcs_server.js";
import { mswFixture } from "#tests/fixtures/msw";
import { sharedKvStoreContextFixture } from "#tests/fixtures/shared_kvstore_context.js";

const msw = mswFixture();
const fakeGcsServer = fakeGcsServerFixture(msw);
const sharedKvStoreContext = sharedKvStoreContextFixture();
const dataSourceProvider = dataSourceProviderFixture(sharedKvStoreContext);

const BUCKET = "versioned";

function imageInfo(size: number) {
  return JSON.stringify({
    type: "image",
    data_type: "uint8",
    num_channels: 1,
    scales: [
      {
        key: "8_8_8",
        size: [size, size, size],
        resolution: [8, 8, 8],
        chunk_sizes: [[64, 64, 64]],
        encoding: "raw",
        voxel_offset: [0, 0, 0],
      },
    ],
  });
}

function annotationInfo(upperBound: number) {
  return JSON.stringify({
    "@type": "neuroglancer_annotations_v1",
    annotation_type: "POINT",
    dimensions: { x: [8e-9, "m"], y: [8e-9, "m"], z: [8e-9, "m"] },
    lower_bound: [0, 0, 0],
    upper_bound: [upperBound, upperBound, upperBound],
    properties: [],
    relationships: [],
    by_id: { key: "by_id" },
    spatial: [
      {
        key: "spatial0",
        grid_shape: [1, 1, 1],
        chunk_size: [upperBound, upperBound, upperBound],
        limit: 1000,
      },
    ],
  });
}

function shardFile(label: string) {
  // Stand-in for a sharded file: index bytes followed by data bytes.
  return `index-${label}|data-${label}`;
}

// Times between the two writes of every object.
let timeAfterFirstWrite: number;
let timeAfterSecondWrite: number;

async function pause() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function writeAll(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await writeObject(fakeGcsServer, BUCKET, path, content);
  }
}

beforeAll(async () => {
  await createBucket(fakeGcsServer, BUCKET, undefined, { versioning: true });
  await writeAll({
    "image/info": imageInfo(64),
    "image/8_8_8/0-64_0-64_0-64": "chunk-v1",
    "image/8_8_8/0.shard": shardFile("v1"),
    "image/8_8_8/1.shard": shardFile("v1"),
    "image/8_8_8/removed-later": "removed",
    "image/8_8_8/history-probe": "probe-v1",
    "annotation/info": annotationInfo(100),
    "annotation/by_id/1": "annotation-1-v1",
    "annotation/spatial0/0_0_0": "spatial-v1",
  });
  await pause();
  timeAfterFirstWrite = Date.now();
  await pause();
  await deleteObject(fakeGcsServer, BUCKET, "image/8_8_8/removed-later");
  await writeAll({
    "image/info": imageInfo(128),
    "image/8_8_8/0-64_0-64_0-64": "chunk-v2",
    "image/8_8_8/0.shard": shardFile("v2"),
    "image/8_8_8/1.shard": shardFile("v2"),
    "image/8_8_8/added-later": "added",
    "image/8_8_8/history-probe": "probe-v2",
    "annotation/info": annotationInfo(200),
    "annotation/by_id/1": "annotation-1-v2",
    "annotation/spatial0/0_0_0": "spatial-v2",
  });
  await pause();
  timeAfterSecondWrite = Date.now();
});

const listRequests: string[] = [];

beforeEach(async () => {
  listRequests.length = 0;
  (await msw()).events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    // Count only viewer requests, not their forwarding to the fake server.
    if (
      url.host === "storage.googleapis.com" &&
      url.searchParams.get("versions") === "true"
    ) {
      listRequests.push(url.searchParams.get("prefix")!);
    }
  });
  return async () => {
    (await msw()).events.removeAllListeners();
  };
});

function layerUrl(layer: string, time: number | undefined) {
  const timePart = time === undefined ? "" : `@${formatVersionTime(time)}/`;
  return `gs://${BUCKET}/${layer}/|versioned:${timePart}`;
}

async function readText(url: string) {
  const response = await (
    await sharedKvStoreContext()
  ).kvStoreContext.read(url);
  return response === undefined ? undefined : response.response.text();
}

describe("kvstore", () => {
  test("reads each object as it was at the chosen time", async () => {
    const first = layerUrl("image", timeAfterFirstWrite);
    const second = layerUrl("image", timeAfterSecondWrite);
    expect(await readText(`${first}8_8_8/0-64_0-64_0-64`)).toBe("chunk-v1");
    expect(await readText(`${second}8_8_8/0-64_0-64_0-64`)).toBe("chunk-v2");
    expect(await readText(`${first}annotation-missing`)).toBeUndefined();
  });

  test("object deleted after the time is still read", async () => {
    expect(
      await readText(
        `${layerUrl("image", timeAfterFirstWrite)}8_8_8/removed-later`,
      ),
    ).toBe("removed");
    expect(
      await readText(
        `${layerUrl("image", timeAfterSecondWrite)}8_8_8/removed-later`,
      ),
    ).toBeUndefined();
  });

  test("object created after the time is missing, not the current one", async () => {
    expect(
      await readText(
        `${layerUrl("image", timeAfterFirstWrite)}8_8_8/added-later`,
      ),
    ).toBeUndefined();
  });

  test("time before any write: everything missing", async () => {
    expect(
      await readText(
        `${layerUrl("image", timeAfterFirstWrite - 3600_000)}info`,
      ),
    ).toBeUndefined();
  });

  test("throwIfMissing reports the versioned url", async () => {
    const url = `${layerUrl("image", timeAfterFirstWrite)}8_8_8/added-later`;
    await expect(
      (await sharedKvStoreContext()).kvStoreContext.read(url, {
        throwIfMissing: true,
      }),
    ).rejects.toThrow(`${url} not found`);
  });

  test("stat at time", async () => {
    const context = (await sharedKvStoreContext()).kvStoreContext;
    expect(
      await context.stat(
        `${layerUrl("image", timeAfterFirstWrite)}8_8_8/0.shard`,
      ),
    ).toEqual({ totalSize: shardFile("v1").length });
    expect(
      await context.stat(
        `${layerUrl("image", timeAfterFirstWrite)}8_8_8/added-later`,
      ),
    ).toBeUndefined();
  });

  test("byte-range reads of one shard file use one version and one listing", async () => {
    const context = (await sharedKvStoreContext()).kvStoreContext;
    // A shard file no other test reads, so its history is not cached yet.
    const url = `${layerUrl("image", timeAfterFirstWrite)}8_8_8/1.shard`;
    const index = await context.read(url, {
      byteRange: { offset: 0, length: 8 },
    });
    const data = await context.read(url, { byteRange: { suffixLength: 7 } });
    expect(await index!.response.text()).toBe("index-v1");
    expect(await data!.response.text()).toBe("data-v1");
    expect(listRequests).toEqual(["image/8_8_8/1.shard"]);
  });

  test("changing the time reuses the cached history", async () => {
    // A file no other test reads, so its history is not cached yet.
    const key = "8_8_8/history-probe";
    expect(
      await readText(`${layerUrl("image", timeAfterFirstWrite)}${key}`),
    ).toBe("probe-v1");
    expect(
      await readText(`${layerUrl("image", timeAfterSecondWrite)}${key}`),
    ).toBe("probe-v2");
    await readText(`${layerUrl("image", timeAfterFirstWrite + 1)}${key}`);
    expect(listRequests).toEqual([`image/${key}`]);
  });

  test("without a time: current data and no version listing", async () => {
    expect(
      await readText(`${layerUrl("image", undefined)}8_8_8/0-64_0-64_0-64`),
    ).toBe("chunk-v2");
    expect(
      await readText(`${layerUrl("image", undefined)}8_8_8/added-later`),
    ).toBe("added");
    expect(listRequests).toEqual([]);
  });

  test("urls round-trip through getUrl", async () => {
    const context = (await sharedKvStoreContext()).kvStoreContext;
    for (const time of [undefined, timeAfterFirstWrite]) {
      const url = `${layerUrl("image", time)}8_8_8/0.shard`;
      const { store, path } = context.getKvStore(url);
      expect(store.getUrl(path)).toBe(url);
    }
  });

  test("listing passes through to current keys", async () => {
    const context = (await sharedKvStoreContext()).kvStoreContext;
    const response = await context.list(
      `${layerUrl("image", timeAfterFirstWrite)}8_8_8/`,
      { responseKeys: "suffix" },
    );
    expect(response.entries.map(({ key }) => key).sort()).toEqual([
      "0-64_0-64_0-64",
      "0.shard",
      "1.shard",
      "added-later",
      "history-probe",
    ]);
  });

  test("earliest version time of a file", async () => {
    const context = (await sharedKvStoreContext()).kvStoreContext;
    const { store, path } = context.getKvStore(
      `${layerUrl("image", undefined)}info`,
    );
    const earliest = await (store as VersionedKvStore).earliestVersionTime(
      path,
      {},
    );
    expect(earliest).toBeLessThan(timeAfterFirstWrite);
    expect(earliest).toBeGreaterThan(timeAfterFirstWrite - 60_000);
  });

  test("non-versionable base store is a clear error", async () => {
    const context = (await sharedKvStoreContext()).kvStoreContext;
    expect(() =>
      context.getKvStore("https://example.com/layer/|versioned:"),
    ).toThrow('"versioned:" requires a gs:// or s3:// bucket');
  });

  test("invalid time is a clear error", async () => {
    const context = (await sharedKvStoreContext()).kvStoreContext;
    expect(() =>
      context.getKvStore(`gs://${BUCKET}/image/|versioned:@yesterday/info`),
    ).toThrow("Invalid URL");
  });

  test("no list permission is a clear error", async () => {
    (await msw()).use(
      http.get(
        "https://storage.googleapis.com/storage/v1/b/forbidden/o",
        () => new HttpResponse(null, { status: 403 }),
      ),
    );
    await expect(
      readText(`gs://forbidden/layer/|versioned:@2026-01-01T00:00:00Z/info`),
    ).rejects.toThrow("No permission to list object versions");
  });
});

describe("precomputed datasource", () => {
  async function modelUpperBound(layer: string, time: number | undefined) {
    const provider = await dataSourceProvider();
    const dataSource = await provider.get({
      url: `${layerUrl(layer, time)}|neuroglancer-precomputed:`,
      globalCoordinateSpace: undefined as any,
      transform: undefined,
    });
    return dataSource.modelTransform.inputSpace.bounds.upperBounds[0];
  }

  test("image metadata at each time", async () => {
    expect(await modelUpperBound("image", timeAfterFirstWrite)).toBe(64);
    expect(await modelUpperBound("image", timeAfterSecondWrite)).toBe(128);
    expect(await modelUpperBound("image", undefined)).toBe(128);
  });

  test("a layer is loaded again at a time only when its info changed since", async () => {
    const { kvStoreContext } = await sharedKvStoreContext();
    const url = `precomputed://gs://${BUCKET}/image`;
    // `info` was rewritten after the first write: load at that time.
    expect(
      await metadataLoadTimeFor(kvStoreContext, url, timeAfterFirstWrite),
    ).toBe(timeAfterFirstWrite);
    // Same `info` as now: keep the current data source.
    expect(
      await metadataLoadTimeFor(kvStoreContext, url, timeAfterSecondWrite),
    ).toBeUndefined();
    expect(
      await metadataLoadTimeFor(kvStoreContext, url, undefined),
    ).toBeUndefined();
  });

  test("a data source loaded at a time reads its info at that time", async () => {
    const provider = await dataSourceProvider();
    const dataSource = await provider.get({
      url: dataSourceUrlAtVersionTime(
        `precomputed://gs://${BUCKET}/image`,
        timeAfterFirstWrite,
      ),
      globalCoordinateSpace: undefined as any,
      transform: undefined,
    });
    expect(dataSource.modelTransform.inputSpace.bounds.upperBounds[0]).toBe(64);
  });

  test("annotation metadata at each time", async () => {
    expect(await modelUpperBound("annotation", timeAfterFirstWrite)).toBe(100);
    expect(await modelUpperBound("annotation", timeAfterSecondWrite)).toBe(200);
    expect(await modelUpperBound("annotation", undefined)).toBe(200);
  });

  test("annotation chunks at each time", async () => {
    const first = layerUrl("annotation", timeAfterFirstWrite);
    expect(await readText(`${first}by_id/1`)).toBe("annotation-1-v1");
    expect(await readText(`${first}spatial0/0_0_0`)).toBe("spatial-v1");
    const second = layerUrl("annotation", timeAfterSecondWrite);
    expect(await readText(`${second}by_id/1`)).toBe("annotation-1-v2");
  });

  test("layer before its first version reports info not found", async () => {
    await expect(
      modelUpperBound("image", timeAfterFirstWrite - 3600_000),
    ).rejects.toThrow(/info.* not found/);
  });
});

test("paths relative to a layer read at a time stay at that time (segmentation meshes, skeletons)", async () => {
  const { kvStoreContext } = await sharedKvStoreContext();
  const time = "2026-11-10T12:00:00Z";
  expect(
    kvStoreContext.resolveRelativePath(
      `gs://${BUCKET}/layer/|versioned:@${time}/`,
      "mesh",
    ),
  ).toBe(`gs://${BUCKET}/layer/|versioned:@${time}/mesh`);
  // A path above the adapter root needs `versioned:` higher up, e.g. at the
  // bucket root.
  expect(() =>
    kvStoreContext.resolveRelativePath(
      `gs://${BUCKET}/layer/|versioned:@${time}/`,
      "../other_layer/skeletons",
    ),
  ).toThrow("Invalid relative path");
  expect(
    kvStoreContext.resolveRelativePath(
      `gs://${BUCKET}/|versioned:@${time}/dataset/layer/`,
      "../other_layer/skeletons",
    ),
  ).toBe(`gs://${BUCKET}/|versioned:@${time}/dataset/other_layer/skeletons`);
});

test("history check of a layer: only its info is listed, or no permission", async () => {
  const { kvStoreContext } = await sharedKvStoreContext();
  const versioned = kvStoreContext.getKvStore(
    `gs://${BUCKET}/annotation/|versioned:`,
  ).store as VersionedKvStore;
  expect(typeof (await versioned.earliestVersionTime("info", {}))).toBe(
    "number",
  );
  // A layer not looked at yet (so nothing cached): one listing of exactly its
  // `info`, never of everything under the layer.
  listRequests.length = 0;
  const unseen = kvStoreContext.getKvStore(
    `gs://${BUCKET}/unseen-layer/|versioned:`,
  ).store as VersionedKvStore;
  expect(await unseen.earliestVersionTime("info", {})).toBeUndefined();
  expect(listRequests).toEqual(["unseen-layer/info"]);
  (await msw()).use(
    http.get(
      "https://storage.googleapis.com/storage/v1/b/privatebucket/o",
      () => new HttpResponse(null, { status: 401 }),
    ),
  );
  const forbidden = kvStoreContext.getKvStore(
    "gs://privatebucket/layer/|versioned:",
  ).store as VersionedKvStore;
  expect(await forbidden.earliestVersionTime("info", {})).toBe("no-permission");
});
