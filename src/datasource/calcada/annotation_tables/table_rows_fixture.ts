/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { FetchedTablePoints } from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import type {
  AnnotationTableInfo,
  TablePoints,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { UNBOUND_ROOT_INDEX } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { SourceScale } from "#src/datasource/calcada/annotation_tables/table_rows.js";

export interface FixturePoint {
  position: [number, number, number];
  rootId?: bigint;
}

export interface FixtureRow {
  id: bigint;
  value: number;
  points: FixturePoint[];
}

export const fixturePoint = (
  position: [number, number, number],
  rootId?: bigint,
): FixturePoint => ({ position, rootId });

export const fixtureRow = (
  id: bigint,
  points: FixturePoint[],
  value = 0.5,
): FixtureRow => ({ id, value, points });

export function fixtureTable(
  name: string,
  pointCount: number,
): AnnotationTableInfo {
  return {
    name,
    schemaName: "synapse",
    schemaVersion: 1,
    description: "",
    voxelResolution: [4, 4, 40],
    points: Array.from({ length: pointCount }, (_, k) => `p${k}`),
    properties: {},
    requiredProperties: [],
    canWrite: false,
  };
}

/** Halves nanometres, so a voxel of [4, 4, 40] nm is [2, 2, 20] source units. */
export const HALF_NANOMETRE_SCALE: SourceScale = {
  rank: 3,
  nanometresPerUnit: [2, 2, 2],
};

function tablePoints(rows: FixtureRow[]): TablePoints {
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

export const fixtureResponse = (
  fetchedUnder: bigint | undefined,
  rows: FixtureRow[],
): FetchedTablePoints => ({ fetchedUnder, points: tablePoints(rows) });
