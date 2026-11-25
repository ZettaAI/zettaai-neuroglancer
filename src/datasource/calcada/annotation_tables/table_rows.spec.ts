/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";
import type { Line, Point } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type { FetchedTablePoints } from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import type { TableRows } from "#src/datasource/calcada/annotation_tables/table_rows.js";
import {
  annotationOfInstance,
  buildTableRows,
  EMPTY_TABLE_ROWS,
  instanceCount,
  instanceId,
  instanceOfId,
  rowCount,
  rowOfInstance,
  withoutRow,
} from "#src/datasource/calcada/annotation_tables/table_rows.js";
import {
  fixturePoint as point,
  fixtureResponse as response,
  fixtureRow as row,
  fixtureTable,
  HALF_NANOMETRE_SCALE,
} from "#src/datasource/calcada/annotation_tables/table_rows_fixture.js";

const build = (pointCount: number, ...responses: FetchedTablePoints[]) =>
  buildTableRows(
    responses,
    fixtureTable("syn", pointCount),
    HALF_NANOMETRE_SCALE,
  );

const rootsOfRow = (rows: TableRows, index: number) =>
  Array.from(
    rows.roots.subarray(rows.rootOffsets[index], rows.rootOffsets[index + 1]),
  );

describe("buildTableRows", () => {
  it("a line table becomes one LINE instance per row in source units", () => {
    const rows = build(
      2,
      response(10n, [
        row(7n, [point([1, 1, 1], 10n), point([2, 2, 2], 10n)]),
        row(3n, [point([0, 0, 0], 10n), point([1, 2, 3], 10n)]),
      ]),
    );
    expect(Array.from(rows.rowIds)).toEqual([3n, 7n]);
    expect(rows.type).toBe(AnnotationType.LINE);
    expect(Array.from(rows.positions.subarray(0, 6))).toEqual([
      0, 0, 0, 2, 4, 60,
    ]);
    expect(instanceCount(rows)).toBe(2);
    expect(instanceId(rows, 1)).toBe("syn:7");
    expect(instanceOfId(rows, "syn:7")).toBe(1);
    expect(instanceOfId(rows, "syn:8")).toBeUndefined();
    expect(instanceOfId(rows, "other:7")).toBeUndefined();
    expect(instanceOfId(rows, "syn:x")).toBeUndefined();
  });

  it("a one-point row is a POINT whose id is the row's", () => {
    const rows = build(1, response(10n, [row(7n, [point([1, 2, 3], 10n)])]));
    const annotation = annotationOfInstance(rows, 0) as Point;
    expect(annotation.type).toBe(AnnotationType.POINT);
    expect(annotation.id).toBe("syn:7");
    expect(Array.from(annotation.point)).toEqual([2, 4, 60]);
    expect(annotation.properties).toEqual([0.5]);
  });

  it("multi-point rows map instances to point ids", () => {
    const three = (id: bigint, value: number) =>
      row(id, [point([0, 0, 0]), point([1, 0, 0]), point([2, 0, 0])], value);
    const rows = build(3, response(10n, [three(9n, 0.25), three(5n, 0.75)]));
    expect(instanceCount(rows)).toBe(6);
    expect(instanceId(rows, 4)).toBe("syn:9:1");
    expect(instanceOfId(rows, "syn:9:1")).toBe(4);
    expect(instanceOfId(rows, "syn:9:3")).toBeUndefined();
    expect(instanceOfId(rows, "syn:9")).toBeUndefined();
    expect(rowOfInstance(rows, 4)).toBe(1);
    expect(annotationOfInstance(rows, 4)).toMatchObject({
      type: AnnotationType.POINT,
      id: "syn:9:1",
      properties: [0.25],
    });
    expect(Array.from((annotationOfInstance(rows, 5) as Point).point)).toEqual([
      4, 0, 0,
    ]);
  });

  it("a row in two responses is one row related to both roots", () => {
    const rows = build(
      2,
      response(10n, [row(1n, [point([0, 0, 0], 10n), point([1, 1, 1])])]),
      response(20n, [row(1n, [point([0, 0, 0]), point([1, 1, 1], 20n)])]),
    );
    expect(rowCount(rows)).toBe(1);
    expect(rootsOfRow(rows, 0).sort()).toEqual([10n, 20n]);
  });

  it("keeps the value of a row's first response", () => {
    const rows = build(
      1,
      response(10n, [row(1n, [point([0, 0, 0])], 0.25)]),
      response(20n, [row(1n, [point([0, 0, 0])], 0.75)]),
    );
    expect(Array.from(rows.values)).toEqual([0.25]);
  });

  it("an unbound row falls back to the root it was fetched under", () => {
    const rows = build(1, response(10n, [row(8n, [point([0, 0, 0])])]));
    expect(rootsOfRow(rows, 0)).toEqual([10n]);
  });

  it("whole-table rows relate to every root of their points, or none", () => {
    const rows = build(
      2,
      response(undefined, [
        row(7n, [point([0, 0, 0], 10n), point([1, 1, 1], 99n)]),
        row(8n, [point([0, 0, 0]), point([1, 1, 1])]),
      ]),
    );
    expect(rootsOfRow(rows, 0)).toEqual([10n, 99n]);
    expect(rootsOfRow(rows, 1)).toEqual([]);
  });

  it("annotationOfInstance gives relatedSegments [[roots of the row]]", () => {
    const rows = build(
      2,
      response(10n, [row(7n, [point([0, 0, 0], 10n), point([2, 2, 1], 99n)])]),
    );
    const annotation = annotationOfInstance(rows, 0) as Line;
    expect(annotation.relatedSegments).toEqual([BigUint64Array.of(10n, 99n)]);
    expect(Array.from(annotation.pointA)).toEqual([0, 0, 0]);
    expect(Array.from(annotation.pointB)).toEqual([4, 4, 20]);
  });

  it("skips rows without points", () => {
    expect(rowCount(build(2, response(10n, [row(7n, [])])))).toBe(0);
  });

  it("pads positions to the source rank with zeros", () => {
    const rows = buildTableRows(
      [response(10n, [row(7n, [point([1, 2, 3])])])],
      fixtureTable("syn", 1),
      { rank: 4, nanometresPerUnit: [2, 2, 2] },
    );
    expect(Array.from(rows.positions)).toEqual([2, 4, 60, 0]);
  });
});

describe("withoutRow", () => {
  it("drops one row's id, value, positions and roots", () => {
    const rows = build(
      1,
      response(10n, [
        row(1n, [point([1, 0, 0], 10n)], 0.1),
        row(2n, [point([2, 0, 0], 20n)], 0.2),
        row(3n, [point([3, 0, 0], 30n)], 0.3),
      ]),
    );
    const remaining = withoutRow(rows, 1);
    expect(Array.from(remaining.rowIds)).toEqual([1n, 3n]);
    expect(Array.from(remaining.values)).toEqual([0.1, 0.3]);
    expect(Array.from(remaining.positions)).toEqual([2, 0, 0, 6, 0, 0]);
    expect(rootsOfRow(remaining, 1)).toEqual([30n]);
    expect(instanceOfId(remaining, "syn:2")).toBeUndefined();
    expect(Array.from(rows.rowIds)).toEqual([1n, 2n, 3n]);
  });
});

describe("EMPTY_TABLE_ROWS", () => {
  it("has no rows and no instances", () => {
    const rows = EMPTY_TABLE_ROWS("syn");
    expect(rows.table).toBe("syn");
    expect(rowCount(rows)).toBe(0);
    expect(instanceCount(rows)).toBe(0);
    expect(instanceOfId(rows, "syn:1")).toBeUndefined();
  });
});
