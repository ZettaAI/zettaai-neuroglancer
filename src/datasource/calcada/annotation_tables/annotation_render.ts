/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Annotation } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type {
  AnnotationTableInfo,
  TablePointColumn,
  TablePoints,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { UNBOUND_ROOT_INDEX } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { vec3 } from "#src/util/geom.js";

export const ANNOTATION_TABLE_COLORS: vec3[] = [
  vec3.fromValues(0.9, 0.3, 0.3),
  vec3.fromValues(0.3, 0.6, 1.0),
  vec3.fromValues(0.4, 0.85, 0.4),
  vec3.fromValues(0.75, 0.4, 0.95),
  vec3.fromValues(1.0, 0.55, 0.15),
  vec3.fromValues(0.2, 0.85, 0.85),
  vec3.fromValues(1.0, 0.45, 0.75),
  vec3.fromValues(0.6, 0.45, 0.3),
];

const LINE_POINT_COUNT = 2;
const SINGLE_POINT_COUNT = 1;
export const COORDINATES_PER_POSITION = 3;
const ANNOTATION_ID_SEPARATOR = ":";

function rowAnnotationId(table: string, rowId: bigint): string {
  return `${table}${ANNOTATION_ID_SEPARATOR}${rowId}`;
}

/** The table row a layer annotation of `table` was drawn from. */
export function annotationRowId(table: string, annotationId: string): bigint {
  const [rowId] = annotationId
    .slice(table.length + ANNOTATION_ID_SEPARATOR.length)
    .split(ANNOTATION_ID_SEPARATOR);
  return BigInt(rowId);
}

export function colorForTable(index: number): vec3 {
  return ANNOTATION_TABLE_COLORS[index % ANNOTATION_TABLE_COLORS.length];
}

type ToLayer = (nm: [number, number, number]) => Float32Array;

export interface FetchedTablePoints {
  fetchedUnder: bigint | undefined;
  points: TablePoints;
}

export interface LayerRow {
  id: bigint;
  value: number;
  annotations: Annotation[];
}

interface PendingRow {
  response: FetchedTablePoints;
  index: number;
}

function dedupeRows(tables: Iterable<FetchedTablePoints>) {
  const rows = new Map<bigint, PendingRow>();
  for (const response of tables) {
    response.points.ids.forEach((id, index) => {
      if (!rows.has(id)) rows.set(id, { response, index });
    });
  }
  return rows;
}

function relatedRoots(
  { response: { fetchedUnder, points }, index }: PendingRow,
  visibleRoots: ReadonlySet<bigint>,
): BigUint64Array {
  const roots: bigint[] = [];
  for (const { rootIndex } of points.points) {
    const pointRootIndex = rootIndex[index];
    if (pointRootIndex === UNBOUND_ROOT_INDEX) continue;
    const root = points.roots[pointRootIndex];
    const related = fetchedUnder === undefined || visibleRoots.has(root);
    if (related && !roots.includes(root)) roots.push(root);
  }
  if (roots.length === 0 && fetchedUnder !== undefined) {
    roots.push(fetchedUnder);
  }
  return BigUint64Array.from(roots);
}

/**
 * Each row once across responses, with the layer annotations it is drawn as.
 * A response fetched for the whole table has no `fetchedUnder`.
 */
export function toLayerAnnotations(
  tables: Iterable<FetchedTablePoints>,
  table: AnnotationTableInfo,
  toLayer: ToLayer,
  visibleRoots: ReadonlySet<bigint>,
): LayerRow[] {
  const [resolutionX, resolutionY, resolutionZ] = table.voxelResolution;
  const place = ({ positions }: TablePointColumn, index: number) => {
    const offset = index * COORDINATES_PER_POSITION;
    return toLayer([
      positions[offset] * resolutionX,
      positions[offset + 1] * resolutionY,
      positions[offset + 2] * resolutionZ,
    ]);
  };
  const layerRows: LayerRow[] = [];
  for (const [rowId, pending] of dedupeRows(tables)) {
    const { response, index } = pending;
    const columns = response.points.points;
    if (columns.length === 0) continue;
    const value = response.points.values[index];
    const common = {
      relatedSegments: [relatedRoots(pending, visibleRoots)],
      properties: [value],
    };
    const id = rowAnnotationId(table.name, rowId);
    let annotations: Annotation[];
    if (columns.length === LINE_POINT_COUNT) {
      annotations = [
        {
          ...common,
          id,
          type: AnnotationType.LINE,
          pointA: place(columns[0], index),
          pointB: place(columns[1], index),
        },
      ];
    } else if (columns.length === SINGLE_POINT_COUNT) {
      annotations = [
        {
          ...common,
          id,
          type: AnnotationType.POINT,
          point: place(columns[0], index),
        },
      ];
    } else {
      annotations = columns.map((column, pointIndex) => ({
        ...common,
        id: `${id}${ANNOTATION_ID_SEPARATOR}${pointIndex}`,
        type: AnnotationType.POINT,
        point: place(column, index),
      }));
    }
    layerRows.push({ id: rowId, value, annotations });
  }
  return layerRows;
}
