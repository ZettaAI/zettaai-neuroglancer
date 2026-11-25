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
import {
  drawnRowsOf,
  NO_DRAWN_ROWS,
} from "#src/datasource/calcada/annotation_tables/drawn_rows.js";
import { buildTableRows } from "#src/datasource/calcada/annotation_tables/table_rows.js";
import {
  fixturePoint,
  fixtureResponse,
  fixtureRow,
  fixtureTable,
  HALF_NANOMETRE_SCALE,
} from "#src/datasource/calcada/annotation_tables/table_rows_fixture.js";

function tableRows(table: string, ids: number[], pointCount = 1) {
  return buildTableRows(
    [
      fixtureResponse(
        10n,
        ids.map((id) =>
          fixtureRow(
            BigInt(id),
            Array.from({ length: pointCount }, () => fixturePoint([0, 0, 0])),
            id / 2,
          ),
        ),
      ),
    ],
    fixtureTable(table, pointCount),
    HALF_NANOMETRE_SCALE,
  );
}

describe("drawnRowsOf", () => {
  it("lists every table's rows in the given order, by index", () => {
    const drawn = drawnRowsOf([tableRows("b", [2, 1]), tableRows("a", [1])]);
    expect(drawn.length).toBe(3);
    expect(drawn.at(0)).toEqual({
      table: "b",
      layerId: "b:1",
      id: 1n,
      value: 0.5,
    });
    expect(drawn.at(2)).toEqual({
      table: "a",
      layerId: "a:1",
      id: 1n,
      value: 0.5,
    });
  });

  it("a multi-point row is one entry under its first point's id", () => {
    const drawn = drawnRowsOf([tableRows("t", [5, 9], 3)]);
    expect(drawn.length).toBe(2);
    expect(drawn.at(1).layerId).toBe("t:9:0");
  });

  it("finds the index of a row from any of its annotation ids", () => {
    const drawn = drawnRowsOf([
      tableRows("a", [1, 2]),
      tableRows("t", [5, 9], 3),
    ]);
    expect(drawn.indexOf("t", "t:9:2")).toBe(3);
    expect(drawn.indexOf("a", "a:2")).toBe(1);
    expect(drawn.indexOf("a", "a:3")).toBeUndefined();
    expect(drawn.indexOf("x", "x:1")).toBeUndefined();
  });

  it("isSameRow compares table and row id across lists", () => {
    const before = drawnRowsOf([tableRows("a", [1, 2]), tableRows("b", [1])]);
    const after = drawnRowsOf([tableRows("a", [2, 3]), tableRows("b", [1])]);
    expect(before.isSameRow(1, after, 0)).toBe(true);
    expect(before.isSameRow(0, after, 0)).toBe(false);
    expect(before.isSameRow(2, after, 2)).toBe(true);
    expect(before.isSameRow(0, after, 2)).toBe(false);
  });

  it("NO_DRAWN_ROWS is empty", () => {
    expect(NO_DRAWN_ROWS.length).toBe(0);
  });
});
