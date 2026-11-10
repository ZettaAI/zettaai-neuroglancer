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
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type { AcceptedCandidateRow } from "#src/datasource/calcada/accepted_candidates_table.js";
import {
  ACCEPTED_CANDIDATE_SCHEMA,
  ACCEPTED_CANDIDATES_TABLE,
  AcceptedCandidatesTable,
  AcceptedLines,
  lineEndAtPiece,
} from "#src/datasource/calcada/accepted_candidates_table.js";

const BASE = "https://host/g";
const BRANCH = 7;
const ROW_ID = "42";
const RESOLUTION = [4, 4, 40];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

function setUp(existing: string[] = []) {
  const tables = [...existing];
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
          schema_type: ACCEPTED_CANDIDATE_SCHEMA,
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
    return json({ ids: [ROW_ID] });
  });
  const tablesSession = { rowWritten: vi.fn(), rowRemoved: vi.fn() };
  const table = new AcceptedCandidatesTable({
    fetchOk,
    baseUrl: BASE,
    toNanometres: (point) => point,
    nanometresPerUnit: () => RESOLUTION,
    tablesSession,
  });
  return { table, posts, tablesSession };
}

const ROW: AcceptedCandidateRow = {
  score: 0.8,
  lineId: 18446744073709551615n,
  depth: 2,
  operationId: 41,
  pieceA: 7n,
  pieceB: 9n,
  pointA: Float32Array.of(80, 120, 800),
  pointB: Float32Array.of(40, 40, 400),
};

const rowsUrl = `${BASE}/annotation/tables/${ACCEPTED_CANDIDATES_TABLE}/annotations?branch_id=${BRANCH}`;

describe("AcceptedCandidatesTable", () => {
  it("creates the table on the first accept, then writes the line on the branch", async () => {
    const { table, posts, tablesSession } = setUp();
    expect(await table.write(BRANCH, ROW)).toBe(BigInt(ROW_ID));
    expect(posts[0].body).toMatchObject({
      table_name: ACCEPTED_CANDIDATES_TABLE,
      schema_type: ACCEPTED_CANDIDATE_SCHEMA,
      schema_version: 1,
      voxel_resolution: RESOLUTION,
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
            payload: {
              score: 0.8,
              line_id: "18446744073709551615",
              depth: 2,
              operation_id: 41,
              piece_a: "7",
              piece_b: "9",
            },
          },
        ],
      },
    });
    expect(tablesSession.rowWritten).toHaveBeenCalledWith(
      ACCEPTED_CANDIDATES_TABLE,
      BigInt(ROW_ID),
    );
  });

  it("leaves out an operation the merge did not report", async () => {
    const { table, posts } = setUp([ACCEPTED_CANDIDATES_TABLE]);
    await table.write(BRANCH, { ...ROW, operationId: undefined });
    expect(posts[0].body.annotations[0].payload).not.toHaveProperty(
      "operation_id",
    );
  });

  it("remove deletes the line on its branch and tells the tables session", async () => {
    const { table, posts, tablesSession } = setUp([ACCEPTED_CANDIDATES_TABLE]);
    await table.remove(BRANCH, 5n);
    expect(posts).toEqual([
      { url: rowsUrl, method: "DELETE", body: { ids: ["5"] } },
    ]);
    expect(tablesSession.rowRemoved).toHaveBeenCalledWith(
      ACCEPTED_CANDIDATES_TABLE,
      5n,
    );
  });
});

function linesSetUp() {
  const written: { branchId: number; row: AcceptedCandidateRow }[] = [];
  const removed: { branchId: number; rowId: bigint }[] = [];
  const errors: string[] = [];
  let nextRowId = 100n;
  const table = {
    writeFails: false,
    async write(branchId: number, row: AcceptedCandidateRow) {
      if (table.writeFails) throw new Error("HTTP 403");
      written.push({ branchId, row });
      return nextRowId++;
    },
    async remove(branchId: number, rowId: bigint) {
      removed.push({ branchId, rowId });
    },
  };
  const lines = new AcceptedLines(table, (message) => errors.push(message));
  return { lines, table, written, removed, errors };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AcceptedLines", () => {
  it("records a line per accept and forgets the newest one, removing its row on its branch", async () => {
    const { lines, written, removed } = linesSetUp();
    lines.record(BRANCH, ROW.lineId, Promise.resolve(ROW));
    lines.record(BRANCH + 1, 5n, Promise.resolve({ ...ROW, lineId: 5n }));
    await settle();
    expect(written.map(({ branchId }) => branchId)).toEqual([
      BRANCH,
      BRANCH + 1,
    ]);
    expect(lines.forgetNewest()).toBe(5n);
    await settle();
    expect(removed).toEqual([{ branchId: BRANCH + 1, rowId: 101n }]);
    expect(lines.forgetNewest()).toBe(ROW.lineId);
    expect(lines.forgetNewest()).toBeUndefined();
  });

  it("an accept whose row failed is still forgotten, and reports the failure once", async () => {
    const { lines, table, removed, errors } = linesSetUp();
    table.writeFails = true;
    lines.record(BRANCH, ROW.lineId, Promise.resolve(ROW));
    await settle();
    expect(errors).toEqual([
      "Could not record the accepted candidate: HTTP 403",
    ]);
    expect(lines.forgetNewest()).toBe(ROW.lineId);
    await settle();
    expect(removed).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("an accept undone while its line's ends are still read loses its row once written", async () => {
    const { lines, written, removed } = linesSetUp();
    let resolveRow!: (row: AcceptedCandidateRow) => void;
    lines.record(
      BRANCH,
      ROW.lineId,
      new Promise((resolve) => {
        resolveRow = resolve;
      }),
    );
    expect(lines.forgetNewest()).toBe(ROW.lineId);
    resolveRow(ROW);
    await settle();
    expect(written).toHaveLength(1);
    expect(removed).toEqual([{ branchId: BRANCH, rowId: 100n }]);
  });

  it("clear forgets every accept and keeps their rows", async () => {
    const { lines, removed } = linesSetUp();
    lines.record(BRANCH, ROW.lineId, Promise.resolve(ROW));
    lines.clear();
    expect(lines.forgetNewest()).toBeUndefined();
    await settle();
    expect(removed).toEqual([]);
  });
});

describe("lineEndAtPiece", () => {
  const space = makeCoordinateSpace({
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    scales: Float64Array.of(16e-9, 16e-9, 45e-9),
  });
  const contact = Float32Array.of(1, 2, 3);
  const spheres = new Map([
    [7n, { center: [160, 320, 450] as const, radiusNm: 10 }],
  ]);

  it("puts the end at the centre of the piece", () => {
    expect(Array.from(lineEndAtPiece(spheres, 7n, contact, space))).toEqual([
      10, 20, 10,
    ]);
  });

  it("keeps the contact for a piece the manifest does not place", () => {
    expect(lineEndAtPiece(spheres, 9n, contact, space)).toBe(contact);
  });

  it("keeps the contact when the view cannot say where nanometres are", () => {
    const flat = makeCoordinateSpace({
      names: ["x", "y"],
      units: ["m", "m"],
      scales: Float64Array.of(16e-9, 16e-9),
    });
    expect(lineEndAtPiece(spheres, 7n, contact, flat)).toBe(contact);
  });
});
