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
  SegmentAnnotation,
  SegmentAnnotationPoint,
  SegmentAnnotations,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
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
const ABSENT_ROOT = 0n;

export function colorForTable(index: number): vec3 {
  return ANNOTATION_TABLE_COLORS[index % ANNOTATION_TABLE_COLORS.length];
}

type ToLayer = (nm: [number, number, number]) => Float32Array;

interface PendingRow {
  row: SegmentAnnotation;
  fetchedUnder: bigint;
}

function dedupeRows(byRoot: Map<bigint, SegmentAnnotations>, table: string) {
  const rows = new Map<bigint, PendingRow>();
  for (const [root, response] of byRoot) {
    for (const row of response.tables.get(table)?.annotations ?? []) {
      if (!rows.has(row.id)) rows.set(row.id, { row, fetchedUnder: root });
    }
  }
  return rows;
}

function relatedRoots(
  { row, fetchedUnder }: PendingRow,
  visible: Map<bigint, SegmentAnnotations>,
): BigUint64Array {
  const roots = new Set<bigint>();
  for (const { rootId } of row.points) {
    if (rootId !== ABSENT_ROOT && visible.has(rootId)) roots.add(rootId);
  }
  return roots.size === 0
    ? BigUint64Array.of(fetchedUnder)
    : BigUint64Array.from(roots);
}

export function toLayerAnnotations(
  byRoot: Map<bigint, SegmentAnnotations>,
  table: AnnotationTableInfo,
  toLayer: ToLayer,
): Annotation[] {
  const place = ({ position }: SegmentAnnotationPoint) =>
    toLayer([
      position[0] * table.voxelResolution[0],
      position[1] * table.voxelResolution[1],
      position[2] * table.voxelResolution[2],
    ]);
  const annotations: Annotation[] = [];
  for (const pending of dedupeRows(byRoot, table.name).values()) {
    const { row } = pending;
    if (row.points.length === 0) continue;
    const common = {
      relatedSegments: [relatedRoots(pending, byRoot)],
      properties: [row.value],
    };
    const id = `${table.name}:${row.id}`;
    if (row.points.length === LINE_POINT_COUNT) {
      annotations.push({
        ...common,
        id,
        type: AnnotationType.LINE,
        pointA: place(row.points[0]),
        pointB: place(row.points[1]),
      });
    } else if (row.points.length === SINGLE_POINT_COUNT) {
      annotations.push({
        ...common,
        id,
        type: AnnotationType.POINT,
        point: place(row.points[0]),
      });
    } else {
      row.points.forEach((point, index) =>
        annotations.push({
          ...common,
          id: `${id}:${index}`,
          type: AnnotationType.POINT,
          point: place(point),
        }),
      );
    }
  }
  return annotations;
}
