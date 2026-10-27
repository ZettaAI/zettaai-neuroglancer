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
import type { AnnotationTableInfo } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import {
  AnnotationTableForbidden,
  AnnotationTableMissing,
  fetchSegmentAnnotations,
  listAnnotationTables,
  retryOnceIfUnauthorized,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { HttpError } from "#src/util/http_request.js";

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
      },
      expect.objectContaining({ name: "b", points: ["pre", "post"] }),
      expect.objectContaining({ name: "c", points: ["at"] }),
    ]);
    expect(fetchOk).toHaveBeenCalledTimes(3);
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

  it("rejects a malformed body", async () => {
    const fetchOk = vi.fn(async () => json({ nope: 1 }));
    await expect(listAnnotationTables(fetchOk, BASE)).rejects.toThrow();
  });
});

describe("fetchSegmentAnnotations", () => {
  const body = (tables: unknown) => json({ root_id: BIG_ID, tables });

  it("requests tables with coordinates and parses ids above 2^53", async () => {
    const fetchOk = vi.fn(async (_url: RequestInfo) =>
      body({
        a: { annotations: [row(BIG_ID)], truncated: false },
        b: { annotations: [], truncated: true },
      }),
    );
    const result = await fetchSegmentAnnotations(
      fetchOk,
      BASE,
      9007199254740993n,
      [info("a"), info("b")],
      { branchId: 3, timestamp: 1500 },
    );
    expect(String(fetchOk.mock.calls[0][0])).toBe(
      `${BASE}/annotation/segment/9007199254740993/annotations?int64_as_str=1&tables=a,b&timestamp=1.5&branch_id=3`,
    );
    expect(result.rootId).toBe(BigInt(BIG_ID));
    expect(result.tables.get("b")).toEqual({
      annotations: [],
      truncated: true,
    });
    const [annotation] = result.tables.get("a")!.annotations;
    expect(annotation.id).toBe(18446744073709551615n);
    expect(annotation.value).toBe(0.5);
    expect(annotation.payload).toEqual({ kind: "x" });
  });

  it("omits default coordinates", async () => {
    const fetchOk = vi.fn(async (_url: RequestInfo) => body({}));
    await fetchSegmentAnnotations(fetchOk, BASE, 5n, [info("a")], {
      branchId: 0,
      timestamp: 0,
    });
    expect(String(fetchOk.mock.calls[0][0])).toBe(
      `${BASE}/annotation/segment/5/annotations?int64_as_str=1&tables=a`,
    );
  });

  it("orders points by schema role and defaults an absent root to 0", async () => {
    const fetchOk = vi.fn(async () =>
      body({ a: { annotations: [row("1")], truncated: false } }),
    );
    const result = await fetchSegmentAnnotations(
      fetchOk,
      BASE,
      5n,
      [info("a")],
      {
        branchId: 0,
        timestamp: 0,
      },
    );
    expect(result.tables.get("a")!.annotations[0].points).toEqual([
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
    const fetchOk = vi.fn(async (url: RequestInfo) => {
      const u = String(url);
      if (u.includes("/annotation/schemas/synapse?version=1")) {
        return json(schemaJson("synapse", 1, ["post", "pre"]));
      }
      return body({
        a: {
          annotations: [
            row("1", { schema_version: 1 }),
            row("2", { schema_version: 1 }),
          ],
          truncated: false,
        },
      });
    });
    const result = await fetchSegmentAnnotations(
      fetchOk,
      BASE,
      5n,
      [info("a")],
      {
        branchId: 0,
        timestamp: 0,
      },
    );
    const [first, second] = result.tables.get("a")!.annotations;
    expect(first.points.map((p) => p.name)).toEqual(["post", "pre"]);
    expect(second.points.map((p) => p.name)).toEqual(["post", "pre"]);
    expect(fetchOk).toHaveBeenCalledTimes(2);
  });

  it("maps 403 to AnnotationTableForbidden naming the table", async () => {
    const fetchOk = vi.fn(() =>
      failing(403, 'no read permission on annotation table "b"'),
    );
    const error = await fetchSegmentAnnotations(
      fetchOk,
      BASE,
      5n,
      [info("a"), info("b")],
      { branchId: 0, timestamp: 0 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AnnotationTableForbidden);
    expect(error.table).toBe("b");
  });

  it("maps 404 to AnnotationTableMissing naming the table", async () => {
    const fetchOk = vi.fn(() => failing(404, 'annotation table "a" not found'));
    const error = await fetchSegmentAnnotations(
      fetchOk,
      BASE,
      5n,
      [info("a")],
      {
        branchId: 0,
        timestamp: 0,
      },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AnnotationTableMissing);
    expect(error.table).toBe("a");
  });

  it("names the whole request when the 403 body has no table", async () => {
    const fetchOk = vi.fn(() => failing(403, "forbidden"));
    const error = await fetchSegmentAnnotations(
      fetchOk,
      BASE,
      5n,
      [info("a"), info("b")],
      { branchId: 0, timestamp: 0 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AnnotationTableForbidden);
    expect(error.table).toBe("a,b");
  });

  it("rethrows other HTTP errors", async () => {
    const fetchOk = vi.fn(() => failing(500, "boom"));
    await expect(
      fetchSegmentAnnotations(fetchOk, BASE, 5n, [info("a")], {
        branchId: 0,
        timestamp: 0,
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("returns an empty result without a request for no tables", async () => {
    const fetchOk = vi.fn(async () => body({}));
    const result = await fetchSegmentAnnotations(fetchOk, BASE, 5n, [], {
      branchId: 0,
      timestamp: 0,
    });
    expect(fetchOk).not.toHaveBeenCalled();
    expect(result).toEqual({ rootId: 5n, tables: new Map() });
  });

  it("rejects a non-object point with the parser error", async () => {
    const fetchOk = vi.fn(async () =>
      body({
        a: {
          annotations: [row("1", { points: { pre: null } })],
          truncated: false,
        },
      }),
    );
    await expect(
      fetchSegmentAnnotations(fetchOk, BASE, 5n, [info("a")], {
        branchId: 0,
        timestamp: 0,
      }),
    ).rejects.toThrow(/"pre"/);
  });

  it("rejects a malformed body", async () => {
    const fetchOk = vi.fn(async () =>
      body({
        a: {
          annotations: [row("1", { points: { pre: {} } })],
          truncated: false,
        },
      }),
    );
    await expect(
      fetchSegmentAnnotations(fetchOk, BASE, 5n, [info("a")], {
        branchId: 0,
        timestamp: 0,
      }),
    ).rejects.toThrow();
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
