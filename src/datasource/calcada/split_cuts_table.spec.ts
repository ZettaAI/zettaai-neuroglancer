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
import type { SplitCutRow } from "#src/datasource/calcada/split_cuts_table.js";
import {
  parseCutLineNm,
  SPLIT_CUT_SCHEMA,
  SPLIT_CUTS_TABLE,
  SplitCutRows,
  SplitCutsTable,
} from "#src/datasource/calcada/split_cuts_table.js";

const BASE = "https://host/g";
const BRANCH = 7;
const RESOLUTION = [4, 4, 40];
const ROW: SplitCutRow = {
  operationId: 41,
  pointA: Float32Array.of(80, 120, 800),
  pointB: Float32Array.of(40, 40, 400),
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

function tableSetUp() {
  const tables: string[] = [];
  const posts: { url: string; method: string; body: any }[] = [];
  const fetchOk = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/annotation/schemas/")) {
      return json({
        points: [
          { name: "pt_a", role: 0 },
          { name: "pt_b", role: 1 },
        ],
        json_schema: {},
      });
    }
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return json({
        tables: tables.map((name) => ({
          table_name: name,
          schema_type: SPLIT_CUT_SCHEMA,
          schema_version: 1,
          description: "",
          reference_table: "",
          voxel_resolution_x: RESOLUTION[0],
          voxel_resolution_y: RESOLUTION[1],
          voxel_resolution_z: RESOLUTION[2],
          access: { write: true },
        })),
      });
    }
    const body = JSON.parse(String(init!.body));
    posts.push({ url, method, body });
    if (url.endsWith("/annotation/tables")) {
      tables.push(body.table_name);
      return json({});
    }
    return json({ ids: ["42"] });
  });
  const tablesSession = { rowWritten: vi.fn(), rowRemoved: vi.fn() };
  const table = new SplitCutsTable({
    fetchOk,
    baseUrl: BASE,
    toNanometres: (point) => point,
    nanometresPerUnit: () => RESOLUTION,
    tablesSession,
  });
  return { table, posts };
}

const rowsUrl = `${BASE}/annotation/tables/${SPLIT_CUTS_TABLE}/annotations?branch_id=${BRANCH}`;

describe("SplitCutsTable", () => {
  it("creates the table on the first split, then writes a line across the cut on the branch", async () => {
    const { table, posts } = tableSetUp();
    expect(await table.write(BRANCH, ROW)).toBe(42n);
    expect(posts[0].body).toMatchObject({
      table_name: SPLIT_CUTS_TABLE,
      schema_type: SPLIT_CUT_SCHEMA,
    });
    expect(posts[1]).toEqual({
      url: rowsUrl,
      method: "POST",
      body: {
        annotations: [
          {
            points: {
              pt_a: { position: [20, 30, 20] },
              pt_b: { position: [10, 10, 10] },
            },
            payload: { operation_id: 41 },
          },
        ],
      },
    });
  });

  it("remove deletes the row on its branch", async () => {
    const { table, posts } = tableSetUp();
    await table.remove(BRANCH, 5n);
    expect(posts).toEqual([
      { url: rowsUrl, method: "DELETE", body: { ids: ["5"] } },
    ]);
  });
});

describe("parseCutLineNm", () => {
  it("reads two points of three numbers and nothing else", () => {
    expect(
      parseCutLineNm([
        [25, 5, 5],
        [30, 5, 5],
      ]),
    ).toEqual([
      [25, 5, 5],
      [30, 5, 5],
    ]);
    expect(parseCutLineNm(undefined)).toBeUndefined();
    expect(parseCutLineNm([[25, 5, 5]])).toBeUndefined();
    expect(
      parseCutLineNm([
        [25, 5],
        [30, 5, 5],
      ]),
    ).toBeUndefined();
    expect(
      parseCutLineNm([
        [25, "5", 5],
        [30, 5, 5],
      ]),
    ).toBeUndefined();
  });
});

function rowsSetUp() {
  const written: { branchId: number; row: SplitCutRow }[] = [];
  const removed: { branchId: number; rowId: bigint }[] = [];
  const errors: string[] = [];
  let nextRowId = 100n;
  const table = {
    writeFails: false,
    async write(branchId: number, row: SplitCutRow) {
      if (table.writeFails) throw new Error("HTTP 403");
      written.push({ branchId, row });
      return nextRowId++;
    },
    async remove(branchId: number, rowId: bigint) {
      removed.push({ branchId, rowId });
    },
  };
  const rows = new SplitCutRows(table, (message) => errors.push(message));
  return { rows, table, written, removed, errors };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SplitCutRows", () => {
  it("writes a row per split and removes it when that split is reverted", async () => {
    const { rows, written, removed } = rowsSetUp();
    rows.record(BRANCH, ROW);
    rows.record(BRANCH + 1, { ...ROW, operationId: 42 });
    expect(written.map(({ row }) => row.operationId)).toEqual([41, 42]);
    rows.reverted(42);
    await settle();
    expect(removed).toEqual([{ branchId: BRANCH + 1, rowId: 101n }]);
    rows.reverted(42);
    await settle();
    expect(removed).toHaveLength(1);
  });

  it("keeps the row of a split that left the undo history", async () => {
    const { rows, removed } = rowsSetUp();
    rows.record(BRANCH, ROW);
    rows.forget(41);
    rows.reverted(41);
    await settle();
    expect(removed).toEqual([]);
  });

  it("reports a failed write and removes nothing on revert", async () => {
    const { rows, table, removed, errors } = rowsSetUp();
    table.writeFails = true;
    rows.record(BRANCH, ROW);
    await settle();
    expect(errors).toEqual(["Could not record the split cut: HTTP 403"]);
    rows.reverted(41);
    await settle();
    expect(removed).toEqual([]);
  });
});
