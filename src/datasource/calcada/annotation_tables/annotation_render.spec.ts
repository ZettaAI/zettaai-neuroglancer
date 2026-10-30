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
import { AnnotationType } from "#src/annotation/index.js";
import {
  ANNOTATION_TABLE_COLORS,
  annotationRowId,
  colorForTable,
  toLayerAnnotations,
} from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import type {
  AnnotationTableInfo,
  TablePoints,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { UNBOUND_ROOT_INDEX } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";

const TABLE: AnnotationTableInfo = {
  name: "syn",
  schemaName: "synapse",
  schemaVersion: 1,
  description: "",
  voxelResolution: [4, 4, 40],
  points: ["pre", "post"],
  properties: {},
  canWrite: false,
};

const toLayer = (nm: [number, number, number]) =>
  Float32Array.of(nm[0] / 2, nm[1] / 2, nm[2] / 2);

interface TestPoint {
  position: [number, number, number];
  rootId?: bigint;
}

interface TestRow {
  id: bigint;
  value: number;
  points: TestPoint[];
}

const point = (
  position: [number, number, number],
  rootId?: bigint,
): TestPoint => ({ position, rootId });

const row = (id: bigint, points: TestPoint[], value = 0.5): TestRow => ({
  id,
  value,
  points,
});

function tablePoints(rows: TestRow[]): TablePoints {
  const roots = [
    ...new Set(
      rows.flatMap(({ points }) =>
        points.flatMap(({ rootId }) => (rootId === undefined ? [] : [rootId])),
      ),
    ),
  ];
  const columnCount = rows[0]?.points.length ?? 0;
  return {
    ids: rows.map(({ id }) => id),
    values: Float64Array.from(rows.map(({ value }) => value)),
    roots,
    points: Array.from({ length: columnCount }, (_, column) => ({
      name: `p${column}`,
      positions: Int32Array.from(
        rows.flatMap(({ points }) => points[column].position),
      ),
      rootIndex: Int32Array.from(rows, ({ points }) => {
        const { rootId } = points[column];
        return rootId === undefined
          ? UNBOUND_ROOT_INDEX
          : roots.indexOf(rootId);
      }),
    })),
  };
}

const response = (fetchedUnder: bigint | undefined, rows: TestRow[]) => ({
  fetchedUnder,
  points: tablePoints(rows),
});

type Response = ReturnType<typeof response>;

const renderRows = (responses: Response[], visibleRoots: bigint[] = []) =>
  toLayerAnnotations(
    responses,
    TABLE,
    toLayer,
    new Set([
      ...responses.flatMap(({ fetchedUnder }) =>
        fetchedUnder === undefined ? [] : [fetchedUnder],
      ),
      ...visibleRoots,
    ]),
  );

const render = (...responses: Response[]) =>
  renderRows(responses).flatMap(({ annotations }) => annotations);

describe("toLayerAnnotations", () => {
  it("draws a one-point row as a point scaled by the table resolution", () => {
    const [annotation] = render(
      response(10n, [row(7n, [point([1, 2, 3], 10n)])]),
    );
    expect(annotation.type).toBe(AnnotationType.POINT);
    expect(annotation.id).toBe("syn:7");
    expect(Array.from((annotation as any).point)).toEqual([2, 4, 60]);
    expect(annotation.properties).toEqual([0.5]);
    expect(annotation.relatedSegments).toEqual([BigUint64Array.of(10n)]);
  });

  it("draws a two-point row as a line from role 0 to role 1", () => {
    const [annotation] = render(
      response(10n, [row(7n, [point([0, 0, 0], 10n), point([2, 2, 1], 10n)])]),
    );
    expect(annotation.type).toBe(AnnotationType.LINE);
    expect(annotation.id).toBe("syn:7");
    expect(Array.from((annotation as any).pointA)).toEqual([0, 0, 0]);
    expect(Array.from((annotation as any).pointB)).toEqual([4, 4, 20]);
  });

  it("draws a three-point row as one point per role", () => {
    const annotations = render(
      response(10n, [
        row(7n, [
          point([0, 0, 0], 10n),
          point([1, 0, 0], 10n),
          point([2, 0, 0], 10n),
        ]),
      ]),
    );
    expect(annotations.map((a) => a.id)).toEqual([
      "syn:7:0",
      "syn:7:1",
      "syn:7:2",
    ]);
    expect(annotations.every((a) => a.type === AnnotationType.POINT)).toBe(
      true,
    );
    expect(Array.from((annotations[2] as any).point)).toEqual([4, 0, 0]);
  });

  it("gives back the row id of each annotation it draws", () => {
    const annotations = render(
      response(10n, [row(7n, [point([0, 0, 0], 10n)])]),
      response(10n, [
        row(8n, [
          point([0, 0, 0], 10n),
          point([1, 0, 0], 10n),
          point([2, 0, 0], 10n),
        ]),
      ]),
    );
    expect(
      annotations.map(({ id }) => annotationRowId(TABLE.name, id)),
    ).toEqual([7n, 8n, 8n, 8n]);
  });

  it("skips rows without points", () => {
    expect(render(response(10n, [row(7n, [])]))).toEqual([]);
  });

  it("draws a cross-segment row once and relates it to both visible roots", () => {
    const shared = row(7n, [point([0, 0, 0], 10n), point([1, 1, 1], 20n)]);
    const annotations = render(
      response(10n, [shared]),
      response(20n, [shared]),
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0].relatedSegments).toEqual([
      BigUint64Array.of(10n, 20n),
    ]);
  });

  it("pairs each drawn row with its id, value and annotations", () => {
    const shared = row(
      7n,
      [point([0, 0, 0], 10n), point([1, 1, 1], 20n)],
      0.25,
    );
    const rows = renderRows([
      response(10n, [shared, row(8n, [point([0, 0, 0]), point([1, 1, 1])])]),
      response(20n, [shared]),
    ]);
    expect(rows.map(({ id, value }) => [id, value])).toEqual([
      [7n, 0.25],
      [8n, 0.5],
    ]);
    expect(rows[0].annotations.map(({ id }) => id)).toEqual(["syn:7"]);
  });

  it("ignores roots that are not visible and falls back to the fetched root", () => {
    const [partner] = render(
      response(10n, [row(7n, [point([0, 0, 0], 10n), point([1, 1, 1], 99n)])]),
    );
    expect(partner.relatedSegments).toEqual([BigUint64Array.of(10n)]);
    const [unresolved] = render(response(10n, [row(8n, [point([0, 0, 0])])]));
    expect(unresolved.relatedSegments).toEqual([BigUint64Array.of(10n)]);
  });

  it("whole-table rows relate to every root of their points", () => {
    const [annotation, unbound] = render(
      response(undefined, [
        row(7n, [point([0, 0, 0], 10n), point([1, 1, 1], 99n)]),
        row(8n, [point([0, 0, 0]), point([1, 1, 1])]),
      ]),
    );
    expect(annotation.relatedSegments).toEqual([BigUint64Array.of(10n, 99n)]);
    expect(unbound.relatedSegments).toEqual([BigUint64Array.of()]);
  });
});

describe("colorForTable", () => {
  it("offers eight colours and wraps around", () => {
    expect(ANNOTATION_TABLE_COLORS).toHaveLength(8);
    expect(colorForTable(8)).toBe(colorForTable(0));
    expect(colorForTable(3)).toBe(ANNOTATION_TABLE_COLORS[3]);
  });
});
