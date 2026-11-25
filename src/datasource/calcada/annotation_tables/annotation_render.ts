/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { TablePoints } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
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

export const COORDINATES_PER_POSITION = 3;
export const ANNOTATION_ID_SEPARATOR = ":";

export function rowAnnotationId(table: string, rowId: bigint): string {
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

export interface FetchedTablePoints {
  fetchedUnder: bigint | undefined;
  points: TablePoints;
}
