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

import { http, HttpResponse } from "msw";
import { beforeAll, expect, test } from "vitest";
import { GcsKvStore } from "#src/kvstore/gcs/index.js";
import { versionLiveAt } from "#src/kvstore/versioned/version_at_time.js";
import {
  createBucket,
  deleteObject,
  fakeGcsServerFixture,
  writeObject,
} from "#tests/fixtures/fake_gcs_server.js";
import { mswFixture } from "#tests/fixtures/msw";

const msw = mswFixture();
const fakeGcsServer = fakeGcsServerFixture(msw);

const BUCKET = "versionedbucket";

const writes: { generation: string; timeCreated: number }[] = [];

async function write(path: string, content: string) {
  const { generation, timeCreated } = await writeObject(
    fakeGcsServer,
    BUCKET,
    path,
    content,
  );
  writes.push({ generation, timeCreated: Date.parse(timeCreated) });
  // Distinct creation times between writes.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeAll(async () => {
  await createBucket(fakeGcsServer, BUCKET, undefined, { versioning: true });
  await write("info", "first");
  await write("info", "second");
  await write("info_old", "other key sharing the prefix");
  await write("gone", "deleted later");
  await deleteObject(fakeGcsServer, BUCKET, "gone");
});

const store = new GcsKvStore(BUCKET);

test("lists every generation of exactly the key", async () => {
  const lifetimes = await store.listObjectVersions("info", {});
  expect(lifetimes.map(({ versionId }) => versionId).sort()).toEqual(
    [writes[0].generation, writes[1].generation].sort(),
  );
  const first = lifetimes.find(
    ({ versionId }) => versionId === writes[0].generation,
  )!;
  expect(first.liveFrom).toBe(writes[0].timeCreated);
  expect(first.liveUntil).toBeDefined();
  const second = lifetimes.find(
    ({ versionId }) => versionId === writes[1].generation,
  )!;
  expect(second.liveUntil).toBeUndefined();
});

test("deleted object keeps its noncurrent generation", async () => {
  const lifetimes = await store.listObjectVersions("gone", {});
  expect(lifetimes).toHaveLength(1);
  expect(lifetimes[0].liveUntil).toBeDefined();
  expect(versionLiveAt(lifetimes, lifetimes[0].liveUntil!)).toBeUndefined();
});

test("missing key has empty history", async () => {
  expect(await store.listObjectVersions("missing", {})).toEqual([]);
});

test("reads a noncurrent generation", async () => {
  const response = await store.readObjectVersion(
    "info",
    writes[0].generation,
    {},
  );
  expect(await response!.response.text()).toBe("first");
  expect(response!.totalSize).toBe(5);
});

test("reads a byte range of a noncurrent generation", async () => {
  const response = await store.readObjectVersion("info", writes[0].generation, {
    byteRange: { offset: 1, length: 3 },
  });
  expect(await response!.response.text()).toBe("irs");
  expect(response!.offset).toBe(1);
  expect(response!.totalSize).toBe(5);
});

test("reads a deleted object's generation", async () => {
  const [{ versionId }] = await store.listObjectVersions("gone", {});
  const response = await store.readObjectVersion("gone", versionId, {});
  expect(await response!.response.text()).toBe("deleted later");
});

test("stats a noncurrent generation", async () => {
  expect(
    await store.statObjectVersion("info", writes[1].generation, {}),
  ).toEqual({ totalSize: 6 });
});

test("unknown generation is missing", async () => {
  expect(await store.readObjectVersion("info", "1", {})).toBeUndefined();
});

test("current read is unchanged", async () => {
  const response = await store.read("info", {});
  expect(await response!.response.text()).toBe("second");
});

test("follows nextPageToken", async () => {
  const requestedTokens: (string | null)[] = [];
  (await msw()).use(
    http.get(
      "https://storage.googleapis.com/storage/v1/b/pagedbucket/o",
      ({ request }) => {
        const pageToken = new URL(request.url).searchParams.get("pageToken");
        requestedTokens.push(pageToken);
        if (pageToken === null) {
          return HttpResponse.json({
            items: [
              {
                name: "key",
                generation: "1",
                timeCreated: "2026-01-01T00:00:00Z",
                timeDeleted: "2026-01-02T00:00:00Z",
              },
            ],
            nextPageToken: "page2",
          });
        }
        return HttpResponse.json({
          items: [
            {
              name: "key",
              generation: "2",
              timeCreated: "2026-01-02T00:00:00Z",
            },
          ],
        });
      },
    ),
  );
  const lifetimes = await new GcsKvStore("pagedbucket").listObjectVersions(
    "key",
    {},
  );
  expect(requestedTokens).toEqual([null, "page2"]);
  expect(lifetimes.map(({ versionId }) => versionId)).toEqual(["1", "2"]);
});

test("listing is bounded to exactly the key", async () => {
  const listUrls: URL[] = [];
  (await msw()).events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    if (url.host === "storage.googleapis.com") listUrls.push(url);
  });
  try {
    await store.listObjectVersions("info", {});
  } finally {
    (await msw()).events.removeAllListeners();
  }
  expect(listUrls).toHaveLength(1);
  expect(listUrls[0].searchParams.get("startOffset")).toBe("info");
  expect(listUrls[0].searchParams.get("endOffset")).toBe("info\x01");
});
