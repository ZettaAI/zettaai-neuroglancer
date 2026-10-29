/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest";
import type {
  AnnotationTableInfo,
  AnnotationTableQuery,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import {
  AnnotationTableForbidden,
  AnnotationTableMissing,
  deleteAnnotationRows,
  fetchAnnotationRows,
  fetchSegmentCounts,
  fetchSegmentPoints,
  fetchTableCount,
  fetchTablePoints,
  listAnnotationTables,
  retryOnceIfUnauthorized,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { HttpError } from "#src/util/http_request.js";

type FetchOkStub = Parameters<typeof fetchSegmentCounts>[0];

const BASE = "https://host/segmentation/api/v1/table/g";
const BIG_ID = "18446744073709551615";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const failing = (status: number, message: string) => {
  const response = new Response(
    JSON.stringify({ code: "X", error: message, message }),
    {
      status,
    },
  );
  return Promise.reject(HttpError.fromResponse(response));
};

const tableJson = (name: string, schemaType = "synapse", version = 2) => ({
  table_name: name,
  schema_type: schemaType,
  schema_version: version,
  description: `${name} table`,
  notice_text: "",
  voxel_resolution_x: 4,
  voxel_resolution_y: 4,
  voxel_resolution_z: 40,
  reference_table: "",
  user_id: "u",
  read_permission: "public",
  write_permission: "private",
  created: "2026-01-01T00:00:00Z",
  last_modified: "2026-01-01T00:00:00Z",
  valid: true,
  access: { read: true, write: true, manage: false },
});

const schemaJson = (name: string, version: number, points: string[]) => ({
  name,
  version,
  description: "",
  json_schema: {},
  value_field: "",
  points: points.map((p, role) => ({ name: p, role })),
  reference: false,
  user_id: "u",
  created: "2026-01-01T00:00:00Z",
});

const info = (name: string, schemaName = "synapse"): AnnotationTableInfo => ({
  name,
  schemaName,
  schemaVersion: 2,
  description: "",
  voxelResolution: [4, 4, 40],
  points: ["pre", "post"],
  properties: {},
  canWrite: true,
});

const query = (name: string): AnnotationTableQuery => ({
  table: info(name),
});

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  value: 0.5,
  payload: { kind: "x" },
  schema_version: 2,
  points: {
    post: { position: [4, 5, 6], piece_id: "7", root_id: BIG_ID },
    pre: { position: [1, 2, 3], piece_id: "8" },
  },
  user_id: "u",
  ts: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("listAnnotationTables", () => {
  it("lists tables with schema points, one lookup per schema version", async () => {
    const fetchOk = vi.fn(async (url: RequestInfo) => {
      const u = String(url);
      if (u.endsWith("/annotation/tables")) {
        return json({
          tables: [tableJson("a"), tableJson("b"), tableJson("c", "mark", 1)],
        });
      }
      if (u.includes("/annotation/schemas/synapse?version=2")) {
        return json(schemaJson("synapse", 2, ["pre", "post"]));
      }
      if (u.includes("/annotation/schemas/mark?version=1")) {
        return json(schemaJson("mark", 1, ["at"]));
      }
      throw new Error(`unexpected ${u}`);
    });
    const tables = await listAnnotationTables(fetchOk, BASE);
    expect(tables).toEqual([
      {
        name: "a",
        schemaName: "synapse",
        schemaVersion: 2,
        description: "a table",
        voxelResolution: [4, 4, 40],
        points: ["pre", "post"],
        properties: {},
        canWrite: true,
      },
      expect.objectContaining({ name: "b", points: ["pre", "post"] }),
      expect.objectContaining({ name: "c", points: ["at"] }),
    ]);
    expect(fetchOk).toHaveBeenCalledTimes(3);
  });

  it("reads the typed properties of the schema", async () => {
    const fetchOk = vi.fn(async (url: RequestInfo) =>
      String(url).endsWith("/annotation/tables")
        ? json({ tables: [tableJson("a")] })
        : json({
            ...schemaJson("synapse", 2, ["pre", "post"]),
            json_schema: {
              properties: {
                size: { type: "number" },
                count: { type: "integer" },
                kind: { type: "string", enum: ["a", "b"] },
                checked: { type: ["boolean", "null"] },
                tags: { type: "array" },
                extra: { type: "object" },
                choice: { enum: ["x", "y"] },
              },
            },
          }),
    );
    const [table] = await listAnnotationTables(fetchOk, BASE);
    expect(table.properties).toEqual({
      size: "number",
      count: "integer",
      kind: "string",
      checked: "boolean",
    });
  });

  it("orders schema points by role", async () => {
    const fetchOk = vi.fn(async (url: RequestInfo) =>
      String(url).endsWith("/annotation/tables")
        ? json({ tables: [tableJson("a")] })
        : json({
            ...schemaJson("synapse", 2, []),
            points: [
              { name: "post", role: 1 },
              { name: "pre", role: 0 },
            ],
          }),
    );
    const [table] = await listAnnotationTables(fetchOk, BASE);
    expect(table.points).toEqual(["pre", "post"]);
  });

  it("leaves out reference tables and never looks up their schema", async () => {
    const fetchOk = vi.fn(async (url: RequestInfo) =>
      String(url).endsWith("/annotation/tables")
        ? json({
            tables: [
              tableJson("a"),
              { ...tableJson("verdicts", "verdict", 1), reference_table: "a" },
            ],
          })
        : json(schemaJson("synapse", 2, ["pre", "post"])),
    );
    const tables = await listAnnotationTables(fetchOk, BASE);
    expect(tables.map((table) => table.name)).toEqual(["a"]);
    expect(
      fetchOk.mock.calls.some(([url]) => String(url).includes("verdict")),
    ).toBe(false);
  });

  it("reads canWrite from access", async () => {
    const fetchOk = vi.fn(async (url: RequestInfo) =>
      String(url).endsWith("/annotation/tables")
        ? json({
            tables: [
              tableJson("a"),
              {
                ...tableJson("b"),
                access: { read: true, write: false, manage: false },
              },
            ],
          })
        : json(schemaJson("synapse", 2, ["pre", "post"])),
    );
    const tables = await listAnnotationTables(fetchOk, BASE);
    expect(tables.map((table) => table.canWrite)).toEqual([true, false]);
  });

  it("allows no write when an older server sends no access", async () => {
    const { access: _access, ...withoutAccess } = tableJson("a");
    const fetchOk = vi.fn(async (url: RequestInfo) =>
      String(url).endsWith("/annotation/tables")
        ? json({ tables: [withoutAccess] })
        : json(schemaJson("synapse", 2, ["pre", "post"])),
    );
    const tables = await listAnnotationTables(fetchOk, BASE);
    expect(tables.map((table) => table.canWrite)).toEqual([false]);
  });

  it("rejects a malformed body", async () => {
    const fetchOk = vi.fn(async () => json({ nope: 1 }));
    await expect(listAnnotationTables(fetchOk, BASE)).rejects.toThrow();
  });
});

describe("annotation rows", () => {
  const coords = { branchId: 0, timestamp: 0 };
  const rowsBody = (...rows: unknown[]) => json({ annotations: rows });
  const readRows = (fetchOk: FetchOkStub) =>
    fetchAnnotationRows(fetchOk, BASE, info("a"), [1n], coords);

  it("parses ids above 2^53, the payload, role order and an absent root as 0", async () => {
    const [annotation] = await readRows(
      vi.fn(async () => rowsBody(row(BIG_ID))),
    );
    expect(annotation.id).toBe(18446744073709551615n);
    expect(annotation.value).toBe(0.5);
    expect(annotation.payload).toEqual({ kind: "x" });
    expect(annotation.points).toEqual([
      { name: "pre", position: [1, 2, 3], pieceId: 8n, rootId: 0n },
      {
        name: "post",
        position: [4, 5, 6],
        pieceId: 7n,
        rootId: BigInt(BIG_ID),
      },
    ]);
  });

  it("uses the schema version a row was written under, cached per version", async () => {
    const fetchOk = vi.fn(async (url: RequestInfo) =>
      String(url).includes("/annotation/schemas/synapse?version=1")
        ? json(schemaJson("synapse", 1, ["post", "pre"]))
        : rowsBody(
            row("1", { schema_version: 1 }),
            row("2", { schema_version: 1 }),
          ),
    );
    const [first, second] = await readRows(fetchOk);
    expect(first.points.map((p) => p.name)).toEqual(["post", "pre"]);
    expect(second.points.map((p) => p.name)).toEqual(["post", "pre"]);
    expect(fetchOk).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-object point with the parser error", async () => {
    await expect(
      readRows(
        vi.fn(async () => rowsBody(row("1", { points: { pre: null } }))),
      ),
    ).rejects.toThrow(/"pre"/);
  });

  it("rejects a malformed body", async () => {
    await expect(
      readRows(vi.fn(async () => rowsBody(row("1", { points: { pre: {} } })))),
    ).rejects.toThrow();
  });
});

describe("table errors", () => {
  const countBoth = (fetchOk: FetchOkStub) =>
    fetchSegmentCounts(fetchOk, BASE, 5n, [query("a"), query("b")], {
      branchId: 0,
      timestamp: 0,
    });

  it("maps 403 to AnnotationTableForbidden naming the table", async () => {
    const error = await countBoth(
      vi.fn(() => failing(403, 'no read permission on annotation table "b"')),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AnnotationTableForbidden);
    expect(error.table).toBe("b");
  });

  it("maps 404 to AnnotationTableMissing naming the table", async () => {
    const error = await countBoth(
      vi.fn(() => failing(404, 'annotation table "a" not found')),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AnnotationTableMissing);
    expect(error.table).toBe("a");
  });

  it("names the whole request when the 403 body has no table", async () => {
    const error = await countBoth(vi.fn(() => failing(403, "forbidden"))).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(AnnotationTableForbidden);
    expect(error.table).toBe("a,b");
  });

  it("rethrows a 404 that names no table, such as a route the server lacks", async () => {
    const routeMissing = () =>
      Promise.reject(
        HttpError.fromResponse(
          new Response("404 page not found", { status: 404 }),
        ),
      );
    for (const fetchOk of [
      vi.fn(routeMissing),
      vi.fn(() => failing(404, "graph not found")),
    ]) {
      const error = await countBoth(fetchOk).catch((e) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).not.toBeInstanceOf(AnnotationTableMissing);
    }
  });

  it("rethrows other HTTP errors", async () => {
    await expect(
      countBoth(vi.fn(() => failing(500, "boom"))),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

const COORDS = { branchId: 0, timestamp: 0 };

const pointsJson = {
  ids: [BIG_ID, "2"],
  values: [0.5, 1],
  roots: ["7", BIG_ID],
  points: [
    { name: "pre", positions: [1, 2, 3, -4, 5, 6], root_index: [0, -1] },
  ],
};

describe("columnar points", () => {
  it("parses columnar points", async () => {
    const fetchOk = vi.fn(async (_url: RequestInfo, _init?: RequestInit) =>
      json({ root_id: "5", tables: { a: pointsJson } }),
    );
    const result = await fetchSegmentPoints(
      fetchOk,
      BASE,
      5n,
      [query("a"), query("missing")],
      { branchId: 3, timestamp: 1500 },
    );
    expect(String(fetchOk.mock.calls[0][0])).toBe(
      `${BASE}/annotation/segment/5/points?timestamp=1.5&branch_id=3`,
    );
    expect([...result.keys()]).toEqual(["a"]);
    const points = result.get("a")!;
    expect(points.ids).toEqual([BigInt(BIG_ID), 2n]);
    expect(points.values).toEqual(new Float64Array([0.5, 1]));
    expect(points.roots).toEqual([7n, BigInt(BIG_ID)]);
    expect(points.points).toHaveLength(1);
    expect(points.points[0].name).toBe("pre");
    expect(points.points[0].positions).toEqual(
      new Int32Array([1, 2, 3, -4, 5, 6]),
    );
    expect(points.points[0].rootIndex).toEqual(new Int32Array([0, -1]));
  });

  it("parses the points of one table", async () => {
    const fetchOk = vi.fn(async (_url: RequestInfo, _init?: RequestInit) =>
      json(pointsJson),
    );
    const filter = { filter_equal_dict: { kind: "x" } };
    const points = await fetchTablePoints(
      fetchOk,
      BASE,
      { ...query("a"), filter },
      COORDS,
    );
    expect(String(fetchOk.mock.calls[0][0])).toBe(
      `${BASE}/annotation/tables/a/points`,
    );
    expect(JSON.parse(String(fetchOk.mock.calls[0][1]?.body))).toEqual(filter);
    expect(points.points[0].rootIndex).toEqual(new Int32Array([0, -1]));
  });

  it("maps 403 on a count to AnnotationTableForbidden", async () => {
    const fetchOk = vi.fn(() => failing(403, "forbidden"));
    const error = await fetchTableCount(
      fetchOk,
      BASE,
      query("a"),
      COORDS,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AnnotationTableForbidden);
    expect(error.table).toBe("a");
  });
});

describe("counts", () => {
  it("counts send the table filter", async () => {
    const fetchOk = vi.fn(async (_url: RequestInfo, _init?: RequestInit) =>
      json({ root_id: "5", tables: { a: { count: 3 }, b: { count: 0 } } }),
    );
    const filter = { filter_equal_dict: { kind: "x" } };
    const counts = await fetchSegmentCounts(
      fetchOk,
      BASE,
      5n,
      [{ ...query("a"), filter }, query("b")],
      COORDS,
    );
    expect(String(fetchOk.mock.calls[0][0])).toBe(
      `${BASE}/annotation/segment/5/count`,
    );
    expect(JSON.parse(String(fetchOk.mock.calls[0][1]?.body))).toEqual({
      tables: { a: filter, b: {} },
    });
    expect(counts).toEqual(
      new Map([
        ["a", 3],
        ["b", 0],
      ]),
    );
  });

  it("sends an empty object for a table without filter", async () => {
    const fetchOk = vi.fn(async (_url: RequestInfo, _init?: RequestInit) =>
      json({ count: 12 }),
    );
    expect(await fetchTableCount(fetchOk, BASE, query("a"), COORDS)).toBe(12);
    expect(String(fetchOk.mock.calls[0][0])).toBe(
      `${BASE}/annotation/tables/a/count`,
    );
    expect(JSON.parse(String(fetchOk.mock.calls[0][1]?.body))).toEqual({});
  });
});

describe("parseTablePoints validation", () => {
  it("rejects mismatched columns", async () => {
    const mismatched = (overrides: Record<string, unknown>) =>
      vi.fn(async () => json({ ...pointsJson, ...overrides }));
    const fetchPoints = (fetchOk: ReturnType<typeof mismatched>) =>
      fetchTablePoints(fetchOk, BASE, query("a"), COORDS);
    await expect(fetchPoints(mismatched({ values: [1] }))).rejects.toThrow(
      /values/,
    );
    await expect(
      fetchPoints(
        mismatched({ points: [{ ...pointsJson.points[0], positions: [1] }] }),
      ),
    ).rejects.toThrow(/pre.positions/);
    await expect(
      fetchPoints(
        mismatched({
          points: [{ ...pointsJson.points[0], root_index: [0, 2] }],
        }),
      ),
    ).rejects.toThrow(/out of range/);
  });
});

describe("fetchAnnotationRows", () => {
  it("reads rows by id with coordinates", async () => {
    const fetchOk = vi.fn(async (_url: RequestInfo) =>
      json({ annotations: [row("1")] }),
    );
    const rows = await fetchAnnotationRows(
      fetchOk,
      BASE,
      info("a"),
      [1n, BigInt(BIG_ID)],
      { branchId: 3, timestamp: 1500 },
    );
    expect(String(fetchOk.mock.calls[0][0])).toBe(
      `${BASE}/annotation/tables/a/annotations?int64_as_str=1&ids=1,${BIG_ID}&timestamp=1.5&branch_id=3`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1n);
    expect(rows[0].points.map((point) => point.name)).toEqual(["pre", "post"]);
  });

  it("returns no rows without a request for no ids", async () => {
    const fetchOk = vi.fn(async () => json({ annotations: [] }));
    expect(
      await fetchAnnotationRows(fetchOk, BASE, info("a"), [], COORDS),
    ).toEqual([]);
    expect(fetchOk).not.toHaveBeenCalled();
  });

  it("maps 403 and 404 to the table errors", async () => {
    const forbidden = await fetchAnnotationRows(
      vi.fn(() => failing(403, "forbidden")),
      BASE,
      info("a"),
      [1n],
      COORDS,
    ).catch((e) => e);
    expect(forbidden).toBeInstanceOf(AnnotationTableForbidden);
    expect(forbidden.table).toBe("a");
    const missing = await fetchAnnotationRows(
      vi.fn(() => failing(404, "annotation table not found")),
      BASE,
      info("a"),
      [1n],
      COORDS,
    ).catch((e) => e);
    expect(missing).toBeInstanceOf(AnnotationTableMissing);
  });
});

describe("deleteAnnotationRows", () => {
  it("maps 403 and 404 to the table errors", async () => {
    const forbidden = await deleteAnnotationRows(
      vi.fn(() => failing(403, "forbidden")),
      BASE,
      "a",
      [1n],
    ).catch((e) => e);
    expect(forbidden).toBeInstanceOf(AnnotationTableForbidden);
    expect(forbidden.table).toBe("a");
    const missing = await deleteAnnotationRows(
      vi.fn(() => failing(404, "annotation table not found")),
      BASE,
      "a",
      [1n],
    ).catch((e) => e);
    expect(missing).toBeInstanceOf(AnnotationTableMissing);
  });

  it("delete sends ids as strings", async () => {
    const fetchOk = vi.fn(async (_url: RequestInfo, _init?: RequestInit) =>
      json({}),
    );
    await deleteAnnotationRows(fetchOk, BASE, "a", [BigInt(BIG_ID), 2n]);
    const [url, init] = fetchOk.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/annotation/tables/a/annotations`);
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ ids: [BIG_ID, "2"] });
  });
});

describe("retryOnceIfUnauthorized", () => {
  it("tries again after a 401 and returns the second result", async () => {
    const attempt = vi
      .fn()
      .mockImplementationOnce(() => failing(401, "token not ready"))
      .mockResolvedValueOnce("listed");
    expect(await retryOnceIfUnauthorized(attempt)).toBe("listed");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second 401", async () => {
    const attempt = vi.fn(() => failing(401, "still not ready"));
    await expect(retryOnceIfUnauthorized(attempt)).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry any other failure", async () => {
    const attempt = vi.fn(() => failing(403, "no"));
    await expect(retryOnceIfUnauthorized(attempt)).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
