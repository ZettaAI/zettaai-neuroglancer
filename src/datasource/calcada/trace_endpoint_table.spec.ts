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
import type { TraceEndpointRow } from "#src/datasource/calcada/trace_endpoint_table.js";
import {
  TRACE_ENDPOINT_SCHEMA,
  TRACE_ENDPOINTS_TABLES,
  TraceEndpointTable,
} from "#src/datasource/calcada/trace_endpoint_table.js";
import { HttpError } from "#src/util/http_request.js";

const BASE = "https://host/g";
const BRANCH = 7;
const ROW_ID = "12345678901234567890";
const RESOLUTION = [4, 4, 40];
const HTTP_CONFLICT = 409;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const tableListing = (names: readonly string[]) => ({
  tables: names.map((name) => ({
    table_name: name,
    schema_type: TRACE_ENDPOINT_SCHEMA,
    schema_version: 1,
    description: "",
    reference_table: "",
    voxel_resolution_x: RESOLUTION[0],
    voxel_resolution_y: RESOLUTION[1],
    voxel_resolution_z: RESOLUTION[2],
    access: { write: true },
  })),
});

interface FakeServer {
  tables: string[];
  createStatus: number | undefined;
  /** Whether a create adds the table to later listings. */
  createAdds: boolean;
}

function fakeFetch(server: FakeServer) {
  const posts: { url: string; body: any }[] = [];
  const fetchOk = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/annotation/schemas/")) {
      return json({ points: [{ name: "pt", role: 0 }], json_schema: {} });
    }
    if (init?.method === "POST" && url.endsWith("/annotation/tables")) {
      const body = JSON.parse(String(init.body));
      posts.push({ url, body });
      if (server.createAdds) server.tables.push(body.table_name);
      if (server.createStatus === HTTP_CONFLICT) {
        throw HttpError.fromResponse(
          new Response(JSON.stringify({ message: "exists" }), {
            status: HTTP_CONFLICT,
          }),
        );
      }
      return json({});
    }
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ ids: [ROW_ID] });
    }
    if (init?.method === "DELETE") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({});
    }
    return json(tableListing(server.tables));
  });
  return { fetchOk, posts };
}

const ROW: TraceEndpointRow = {
  status: "uncertain",
  threshold: 0.5,
  radiusNm: 300,
  after: "reject",
  lineId: 18446744073709551615n,
  position: Float32Array.of(80, 120, 800),
};

const CERTAIN_ROW: TraceEndpointRow = { ...ROW, status: "certain" };
const UNCERTAIN_TABLE = TRACE_ENDPOINTS_TABLES.uncertain;
const CERTAIN_TABLE = TRACE_ENDPOINTS_TABLES.certain;

const newServer = (overrides: Partial<FakeServer> = {}): FakeServer => ({
  tables: [],
  createStatus: undefined,
  createAdds: true,
  ...overrides,
});

function makeTable(
  server: FakeServer,
  options: {
    toNanometres?: (point: Float32Array) => Float32Array | undefined;
  } = {},
) {
  const { fetchOk, posts } = fakeFetch(server);
  const tablesSession = { rowWritten: vi.fn(), rowRemoved: vi.fn() };
  const table = new TraceEndpointTable({
    fetchOk,
    baseUrl: BASE,
    toNanometres: options.toNanometres ?? ((point) => point),
    nanometresPerUnit: () => RESOLUTION,
    tablesSession,
  });
  return { table, fetchOk, posts, tablesSession };
}

const rowsUrl = (table: string) =>
  `${BASE}/annotation/tables/${table}/annotations?branch_id=${BRANCH}`;
const rowUrl = rowsUrl(UNCERTAIN_TABLE);

describe("TraceEndpointTable", () => {
  it("creates the table on first write, then writes the row on the branch", async () => {
    const { table, posts, tablesSession } = makeTable(newServer());
    expect(await table.write(BRANCH, ROW)).toBe(BigInt(ROW_ID));
    expect(posts).toEqual([
      {
        url: `${BASE}/annotation/tables`,
        body: {
          table_name: UNCERTAIN_TABLE,
          schema_type: TRACE_ENDPOINT_SCHEMA,
          schema_version: 1,
          voxel_resolution: RESOLUTION,
          description: expect.any(String),
          read_permission: "PUBLIC",
          write_permission: "PUBLIC",
        },
      },
      {
        url: rowUrl,
        body: {
          annotations: [
            {
              points: { pt: { position: [20, 30, 20] } },
              payload: {
                status: "uncertain",
                threshold: 0.5,
                radius_nm: 300,
                after: "reject",
                line_id: "18446744073709551615",
              },
            },
          ],
        },
      },
    ]);
    expect(tablesSession.rowWritten).toHaveBeenCalledWith(
      UNCERTAIN_TABLE,
      BigInt(ROW_ID),
    );
  });

  it("takes an existing table without creating it", async () => {
    const { table, posts } = makeTable(
      newServer({ tables: [UNCERTAIN_TABLE] }),
    );
    await table.write(BRANCH, ROW);
    expect(posts.map(({ url }) => url)).toEqual([rowUrl]);
  });

  it("a create that answers 409 is followed by a list that finds the table", async () => {
    const { table, posts } = makeTable(
      newServer({ createStatus: HTTP_CONFLICT }),
    );
    await table.write(BRANCH, ROW);
    expect(posts.map(({ url }) => url)).toEqual([
      `${BASE}/annotation/tables`,
      rowUrl,
    ]);
  });

  it("rejects naming the table when it is still absent after a create", async () => {
    const { table, posts } = makeTable(newServer({ createAdds: false }));
    await expect(table.write(BRANCH, ROW)).rejects.toThrow(UNCERTAIN_TABLE);
    expect(posts).toHaveLength(1);
  });

  it("ensures once across two writes", async () => {
    const { table, posts } = makeTable(newServer());
    await table.write(BRANCH, ROW);
    await table.write(BRANCH, ROW);
    expect(
      posts.filter(({ url }) => url === `${BASE}/annotation/tables`),
    ).toHaveLength(1);
  });

  it("retries the ensure after a failed one", async () => {
    const server = newServer({ createAdds: false });
    const { table, posts } = makeTable(server);
    await expect(table.write(BRANCH, ROW)).rejects.toThrow();
    server.createAdds = true;
    await table.write(BRANCH, ROW);
    expect(posts.at(-1)?.url).toBe(rowUrl);
  });

  it("certain and uncertain ends go to their own tables", async () => {
    const { table, posts, tablesSession } = makeTable(newServer());
    await table.write(BRANCH, CERTAIN_ROW);
    await table.write(BRANCH, ROW);
    expect(posts.map(({ url, body }) => body.table_name ?? url)).toEqual([
      CERTAIN_TABLE,
      rowsUrl(CERTAIN_TABLE),
      UNCERTAIN_TABLE,
      rowUrl,
    ]);
    expect(tablesSession.rowWritten.mock.calls.map(([name]) => name)).toEqual([
      CERTAIN_TABLE,
      UNCERTAIN_TABLE,
    ]);
  });

  it("a certain end is removed from the certain table", async () => {
    const { table, posts, tablesSession } = makeTable(newServer());
    await table.remove(BRANCH, "certain", 5n);
    expect(posts.map(({ url }) => url)).toEqual([rowsUrl(CERTAIN_TABLE)]);
    expect(tablesSession.rowRemoved).toHaveBeenCalledWith(CERTAIN_TABLE, 5n);
  });

  it("a seed end is written without a decision or a line", async () => {
    const { table, posts } = makeTable(
      newServer({ tables: [UNCERTAIN_TABLE] }),
    );
    const { after: _after, lineId: _lineId, ...seedEnd } = ROW;
    await table.write(BRANCH, seedEnd);
    expect(posts[0].body.annotations[0].payload).toEqual({
      status: "uncertain",
      threshold: 0.5,
      radius_nm: 300,
    });
  });

  it("refuses when the point cannot be converted", async () => {
    const { table, fetchOk } = makeTable(newServer(), {
      toNanometres: () => undefined,
    });
    await expect(table.write(BRANCH, ROW)).rejects.toThrow("nanometres");
    expect(fetchOk).not.toHaveBeenCalled();
  });

  it("remove deletes on the branch and tells the tables session", async () => {
    const { table, posts, tablesSession } = makeTable(newServer());
    await table.remove(BRANCH, "uncertain", 5n);
    expect(posts).toEqual([{ url: rowUrl, body: { ids: ["5"] } }]);
    expect(tablesSession.rowRemoved).toHaveBeenCalledWith(UNCERTAIN_TABLE, 5n);
  });
});
