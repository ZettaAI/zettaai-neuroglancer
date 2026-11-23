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

import "#src/kvstore/s3/register_frontend.js";
import "#src/kvstore/http/register_frontend.js";
import "#src/kvstore/versioned/register.js";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, test } from "vitest";
import type { ObjectVersionStore } from "#src/kvstore/versioned/object_version_store.js";
import { formatVersionTime } from "#src/kvstore/versioned/url.js";
import { versionLiveAt } from "#src/kvstore/versioned/version_at_time.js";
import {
  createBucket,
  deleteObject,
  enableBucketVersioning,
  fakeS3ServerFixture,
  writeObject,
} from "#tests/fixtures/fake_s3_server.js";
import { mswFixture } from "#tests/fixtures/msw";
import { sharedKvStoreContextFixture } from "#tests/fixtures/shared_kvstore_context.js";

const msw = mswFixture();
const fakeS3Server = fakeS3ServerFixture({ msw });
const sharedKvStoreContext = sharedKvStoreContextFixture();

const BUCKET = "versionedbucket";

// S3 `LastModified` has 1 s precision.
async function pastOneSecond() {
  await new Promise((resolve) => setTimeout(resolve, 1100));
}

let timeAfterFirstWrite: number;
let timeAfterSecondWrite: number;

beforeAll(async () => {
  await createBucket(fakeS3Server, BUCKET);
  await writeObject(fakeS3Server, BUCKET, "layer/before-versioning", "pre");
  await enableBucketVersioning(fakeS3Server, BUCKET);
  await writeObject(fakeS3Server, BUCKET, "layer/info", "info-v1");
  await writeObject(fakeS3Server, BUCKET, "layer/info_old", "other key");
  await writeObject(fakeS3Server, BUCKET, "layer/gone", "deleted later");
  await pastOneSecond();
  timeAfterFirstWrite = Date.now();
  await pastOneSecond();
  await writeObject(fakeS3Server, BUCKET, "layer/info", "info-v2");
  await writeObject(fakeS3Server, BUCKET, "layer/added", "added later");
  await deleteObject(fakeS3Server, BUCKET, "layer/gone");
  await pastOneSecond();
  timeAfterSecondWrite = Date.now();
}, 30000);

async function readText(url: string) {
  const response = await (
    await sharedKvStoreContext()
  ).kvStoreContext.read(url);
  return response === undefined ? undefined : response.response.text();
}

describe.for([
  ["s3://", `s3://${BUCKET}/layer/`],
  ["s3+https:// path style", `s3+https://s3.amazonaws.com/${BUCKET}/layer/`],
  [
    "s3+https:// virtual hosted style",
    `s3+https://${BUCKET}.s3.amazonaws.com/layer/`,
  ],
])("%s", ([, layerUrl]) => {
  function at(time: number | undefined) {
    const timePart = time === undefined ? "" : `@${formatVersionTime(time)}/`;
    return `${layerUrl}|versioned:${timePart}`;
  }

  test("reads each object as it was at the chosen time", async () => {
    expect(await readText(`${at(timeAfterFirstWrite)}info`)).toBe("info-v1");
    expect(await readText(`${at(timeAfterSecondWrite)}info`)).toBe("info-v2");
    expect(await readText(`${at(undefined)}info`)).toBe("info-v2");
  });

  test("delete marker: present before, absent after", async () => {
    expect(await readText(`${at(timeAfterFirstWrite)}gone`)).toBe(
      "deleted later",
    );
    expect(await readText(`${at(timeAfterSecondWrite)}gone`)).toBeUndefined();
  });

  test("created after the time: missing, not the current object", async () => {
    expect(await readText(`${at(timeAfterFirstWrite)}added`)).toBeUndefined();
  });

  test("object written before versioning was enabled ('null' version)", async () => {
    expect(await readText(`${at(timeAfterFirstWrite)}before-versioning`)).toBe(
      "pre",
    );
  });

  test("byte range read at a time", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${at(timeAfterFirstWrite)}info`, {
      byteRange: { suffixLength: 2 },
    });
    expect(await response!.response.text()).toBe("v1");
  });
});

describe("store", () => {
  async function store() {
    return (await sharedKvStoreContext()).kvStoreContext.getKvStore(
      `s3://${BUCKET}/`,
    ).store as unknown as ObjectVersionStore;
  }

  test("lists only the exact key", async () => {
    const lifetimes = await (
      await store()
    ).listObjectVersions("layer/info", {});
    expect(lifetimes).toHaveLength(2);
    expect(versionLiveAt(lifetimes, timeAfterFirstWrite)).toBeDefined();
  });

  test("delete marker ends the last version", async () => {
    const lifetimes = await (
      await store()
    ).listObjectVersions("layer/gone", {});
    expect(lifetimes).toHaveLength(1);
    expect(lifetimes[0].liveUntil).toBeDefined();
  });

  test("stat of a version", async () => {
    const lifetimes = await (
      await store()
    ).listObjectVersions("layer/info", {});
    const version = versionLiveAt(lifetimes, timeAfterFirstWrite)!;
    expect(
      await (
        await store()
      ).statObjectVersion("layer/info", version.versionId, {}),
    ).toEqual({ totalSize: "info-v1".length });
  });

  test("follows pagination markers", async () => {
    const requestedMarkers: (string | null)[] = [];
    (await msw()).use(
      http.get("https://pagedbucket.s3.amazonaws.com/", ({ request }) => {
        const keyMarker = new URL(request.url).searchParams.get("key-marker");
        requestedMarkers.push(keyMarker);
        const namespace = "http://s3.amazonaws.com/doc/2006-03-01/";
        const body =
          keyMarker === null
            ? `<ListVersionsResult xmlns="${namespace}"><IsTruncated>true</IsTruncated>` +
              "<NextKeyMarker>key</NextKeyMarker><NextVersionIdMarker>b</NextVersionIdMarker>" +
              "<Version><Key>key</Key><VersionId>b</VersionId><IsLatest>true</IsLatest>" +
              "<LastModified>2026-01-02T00:00:00.000Z</LastModified></Version>" +
              "</ListVersionsResult>"
            : `<ListVersionsResult xmlns="${namespace}"><IsTruncated>false</IsTruncated>` +
              "<Version><Key>key</Key><VersionId>a</VersionId><IsLatest>false</IsLatest>" +
              "<LastModified>2026-01-01T00:00:00.000Z</LastModified></Version>" +
              "</ListVersionsResult>";
        return new HttpResponse(body, {
          headers: { "content-type": "application/xml" },
        });
      }),
    );
    const pagedStore = (await sharedKvStoreContext()).kvStoreContext.getKvStore(
      "s3://pagedbucket/",
    ).store as unknown as ObjectVersionStore;
    const lifetimes = await pagedStore.listObjectVersions("key", {});
    expect(requestedMarkers).toEqual([null, "key"]);
    expect(versionLiveAt(lifetimes, Date.UTC(2026, 0, 1, 12))?.versionId).toBe(
      "a",
    );
    expect(versionLiveAt(lifetimes, Date.UTC(2026, 0, 3))?.versionId).toBe("b");
  });
});

describe("listing edge cases", () => {
  const namespace = "http://s3.amazonaws.com/doc/2006-03-01/";

  function listingResponse(body: string) {
    return new HttpResponse(
      `<ListVersionsResult xmlns="${namespace}">${body}</ListVersionsResult>`,
      { headers: { "content-type": "application/xml" } },
    );
  }

  function version(key: string, versionId: string, lastModified: string) {
    return (
      `<Version><Key>${key}</Key><VersionId>${versionId}</VersionId>` +
      `<IsLatest>true</IsLatest><LastModified>${lastModified}</LastModified></Version>`
    );
  }

  async function storeFor(url: string) {
    return (await sharedKvStoreContext()).kvStoreContext.getKvStore(url)
      .store as unknown as ObjectVersionStore;
  }

  test("key with a space ('+' in url-encoded listings)", async () => {
    (await msw()).use(
      http.get("https://spacebucket.s3.amazonaws.com/", () =>
        listingResponse(
          "<IsTruncated>false</IsTruncated>" +
            version("layer%2Fmy+file", "v1", "2026-01-01T00:00:00.000Z"),
        ),
      ),
    );
    const lifetimes = await (
      await storeFor("s3://spacebucket/")
    ).listObjectVersions("layer/my file", {});
    expect(lifetimes.map(({ versionId }) => versionId)).toEqual(["v1"]);
  });

  test("stops paging once a later key appears", async () => {
    let requests = 0;
    (await msw()).use(
      http.get("https://stopbucket.s3.amazonaws.com/", () => {
        ++requests;
        return listingResponse(
          "<IsTruncated>true</IsTruncated>" +
            "<NextKeyMarker>key0</NextKeyMarker><NextVersionIdMarker>x</NextVersionIdMarker>" +
            version("key", "v1", "2026-01-01T00:00:00.000Z") +
            version("key0", "x", "2026-01-01T00:00:00.000Z"),
        );
      }),
    );
    const lifetimes = await (
      await storeFor("s3://stopbucket/")
    ).listObjectVersions("key", {});
    expect(requests).toBe(1);
    expect(lifetimes.map(({ versionId }) => versionId)).toEqual(["v1"]);
  });

  test("no list permission on an s3+https:// bucket is reported as such", async () => {
    (await msw()).use(
      http.get(
        /^https:\/\/forbidden\.example\.com\/.*/,
        () => new HttpResponse(null, { status: 403 }),
      ),
    );
    await expect(
      readText(
        "s3+https://forbidden.example.com/bucket/layer/|versioned:@2026-01-01T00:00:00Z/info",
      ),
    ).rejects.toThrow("No permission to list object versions");
  });
});

test("version listing parses without DOMParser (chunk worker)", async () => {
  const savedDomParser = globalThis.DOMParser;
  // Web workers have no DOMParser; chunk reads happen there.
  delete (globalThis as { DOMParser?: unknown }).DOMParser;
  try {
    const store = (await sharedKvStoreContext()).kvStoreContext.getKvStore(
      `s3://${BUCKET}/`,
    ).store as unknown as ObjectVersionStore;
    const lifetimes = await store.listObjectVersions("layer/info", {});
    expect(lifetimes).toHaveLength(2);
  } finally {
    globalThis.DOMParser = savedDomParser;
  }
});

test("xml entities in version ids are decoded", async () => {
  (await msw()).use(
    http.get(
      "https://entitybucket.s3.amazonaws.com/",
      () =>
        new HttpResponse(
          '<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
            "<IsTruncated>false</IsTruncated><Version><Key>key</Key>" +
            "<VersionId>a&amp;b&#43;c</VersionId><IsLatest>true</IsLatest>" +
            "<LastModified>2026-01-01T00:00:00.000Z</LastModified></Version>" +
            "</ListVersionsResult>",
          { headers: { "content-type": "application/xml" } },
        ),
    ),
  );
  const store = (await sharedKvStoreContext()).kvStoreContext.getKvStore(
    "s3://entitybucket/",
  ).store as unknown as ObjectVersionStore;
  const lifetimes = await store.listObjectVersions("key", {});
  expect(lifetimes.map(({ versionId }) => versionId)).toEqual(["a&b+c"]);
});

test("a read cancelled during url style detection does not fail reads waiting for it", async () => {
  // Path style: only `/<bucket>/` answers; the virtual hosted attempt fails.
  (await msw()).use(
    http.get("https://cancelled-detection.example.com/cbucket/", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new HttpResponse(
        '<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          "<IsTruncated>false</IsTruncated><Version><Key>key</Key>" +
          "<VersionId>v1</VersionId><IsLatest>true</IsLatest>" +
          "<LastModified>2026-01-01T00:00:00.000Z</LastModified></Version>" +
          "</ListVersionsResult>",
        { headers: { "content-type": "application/xml" } },
      );
    }),
    http.get(
      "https://cancelled-detection.example.com/",
      () => new HttpResponse(null, { status: 404 }),
    ),
  );
  const store = (await sharedKvStoreContext()).kvStoreContext.getKvStore(
    "s3+https://cancelled-detection.example.com/",
  ).store as unknown as ObjectVersionStore;
  const cancelled = new AbortController();
  const startingRead = store.listObjectVersions("cbucket/key", {
    signal: cancelled.signal,
  });
  const waitingRead = store.listObjectVersions("cbucket/key", {});
  cancelled.abort(new DOMException("chunk download cancelled", "AbortError"));
  await expect(startingRead).rejects.toThrow("chunk download cancelled");
  const lifetimes = await waitingRead;
  expect(lifetimes.map(({ versionId }) => versionId)).toEqual(["v1"]);
});

describe("changes under a prefix", () => {
  async function storeFor(url: string) {
    return (await sharedKvStoreContext()).kvStoreContext.getKvStore(url)
      .store as unknown as ObjectVersionStore;
  }

  test("a rewritten object counts as history", async () => {
    // `layer/info` was rewritten in beforeAll.
    const page = await (
      await storeFor(`s3://${BUCKET}/`)
    ).listChangesUnder("layer/", undefined, {});
    expect(page.hasEarlierVersion).toBe(true);
    expect(page.nextCursor).toBeUndefined();
  });

  test("a bucket with only current versions has none", async () => {
    (await msw()).use(
      http.get(
        "https://plainbucket.s3.amazonaws.com/",
        () =>
          new HttpResponse(
            '<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
              "<IsTruncated>false</IsTruncated><Version><Key>layer/info</Key>" +
              "<VersionId>null</VersionId><IsLatest>true</IsLatest>" +
              "<LastModified>2026-01-01T00:00:00.000Z</LastModified></Version>" +
              "</ListVersionsResult>",
            { headers: { "content-type": "application/xml" } },
          ),
      ),
    );
    const page = await (
      await storeFor("s3://plainbucket/")
    ).listChangesUnder("layer/", undefined, {});
    expect(page.hasEarlierVersion).toBe(false);
    // `LastModified` has whole seconds: counted from the end of that second.
    expect(page.changeTimes).toEqual([
      Date.parse("2026-01-01T00:00:00.000Z") + 999,
    ]);
  });

  test("a truncated listing continues from its markers", async () => {
    const requests: URL[] = [];
    (await msw()).use(
      http.get("https://pagedbucket.s3.amazonaws.com/", ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        const first = url.searchParams.get("key-marker") === null;
        return new HttpResponse(
          '<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
            (first
              ? "<IsTruncated>true</IsTruncated>" +
                "<NextKeyMarker>layer/a</NextKeyMarker>" +
                "<NextVersionIdMarker>v1</NextVersionIdMarker>" +
                "<Version><Key>layer/a</Key><VersionId>v1</VersionId>" +
                "<IsLatest>true</IsLatest>" +
                "<LastModified>2026-01-01T00:00:00.000Z</LastModified></Version>"
              : "<IsTruncated>false</IsTruncated>" +
                "<DeleteMarker><Key>layer/b</Key><VersionId>v2</VersionId>" +
                "<IsLatest>true</IsLatest>" +
                "<LastModified>2026-01-02T00:00:00.000Z</LastModified></DeleteMarker>") +
            "</ListVersionsResult>",
          { headers: { "content-type": "application/xml" } },
        );
      }),
    );
    const store = await storeFor("s3://pagedbucket/");
    const first = await store.listChangesUnder("layer/", undefined, {});
    expect(first.hasEarlierVersion).toBe(false);
    expect(first.nextCursor).toBeDefined();
    const second = await store.listChangesUnder("layer/", first.nextCursor, {});
    expect(second.hasEarlierVersion).toBe(true);
    expect(second.nextCursor).toBeUndefined();
    const last = requests[requests.length - 1];
    expect(last.searchParams.get("key-marker")).toBe("layer/a");
    expect(last.searchParams.get("version-id-marker")).toBe("v1");
  });
});
