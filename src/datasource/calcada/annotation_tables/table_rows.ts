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
import type { FetchedTablePoints } from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import {
  ANNOTATION_ID_SEPARATOR,
  COORDINATES_PER_POSITION,
  rowAnnotationId,
} from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import type {
  AnnotationTableInfo,
  TablePoints,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { UNBOUND_ROOT_INDEX } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { Endianness, ENDIANNESS } from "#src/util/endian.js";

const LINE_POINT_COUNT = 2;
const ROW_ID_PATTERN = /^\d+$/;

export interface SourceScale {
  rank: number;
  nanometresPerUnit: readonly number[];
}

/** A table's drawn rows as columns, one entry per row in ascending id. */
export interface TableRows {
  readonly table: string;
  readonly type: AnnotationType.POINT | AnnotationType.LINE;
  readonly pointsPerRow: number;
  readonly rank: number;
  readonly rowIds: BigUint64Array;
  readonly values: Float64Array;
  /** [row][point][dimension], in source units. */
  readonly positions: Float32Array;
  readonly rootOffsets: Uint32Array;
  readonly roots: BigUint64Array;
}

export const EMPTY_TABLE_ROWS = (table: string): TableRows => ({
  table,
  type: AnnotationType.POINT,
  pointsPerRow: 0,
  rank: 0,
  rowIds: new BigUint64Array(0),
  values: new Float64Array(0),
  positions: new Float32Array(0),
  rootOffsets: Uint32Array.of(0),
  roots: new BigUint64Array(0),
});

export function rowCount(rows: TableRows): number {
  return rows.rowIds.length;
}

export function instanceCount(rows: TableRows): number {
  return rows.type === AnnotationType.LINE
    ? rowCount(rows)
    : rowCount(rows) * rows.pointsPerRow;
}

function hasPointSuffix(rows: TableRows) {
  return rows.pointsPerRow > LINE_POINT_COUNT;
}

function instancesPerRow(rows: TableRows) {
  return rows.type === AnnotationType.LINE ? 1 : rows.pointsPerRow;
}

export function rowOfInstance(rows: TableRows, instance: number): number {
  return Math.floor(instance / instancesPerRow(rows));
}

export function instanceId(rows: TableRows, instance: number): string {
  const id = rowAnnotationId(
    rows.table,
    rows.rowIds[rowOfInstance(rows, instance)],
  );
  if (!hasPointSuffix(rows)) return id;
  return `${id}${ANNOTATION_ID_SEPARATOR}${instance % rows.pointsPerRow}`;
}

function rowIndexOf(rowIds: BigUint64Array, rowId: bigint) {
  let low = 0;
  let high = rowIds.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const middleId = rowIds[middle];
    if (middleId === rowId) return middle;
    if (middleId < rowId) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

export function instanceOfId(rows: TableRows, id: string): number | undefined {
  const prefix = `${rows.table}${ANNOTATION_ID_SEPARATOR}`;
  if (!id.startsWith(prefix)) return undefined;
  const parts = id.slice(prefix.length).split(ANNOTATION_ID_SEPARATOR);
  const expectedParts = hasPointSuffix(rows) ? 2 : 1;
  if (parts.length !== expectedParts) return undefined;
  if (!parts.every((part) => ROW_ID_PATTERN.test(part))) return undefined;
  const [rowPart, pointPart] = parts;
  const row = rowIndexOf(rows.rowIds, BigInt(rowPart));
  if (row === undefined) return undefined;
  if (pointPart === undefined) return row;
  const pointIndex = Number(pointPart);
  if (pointIndex >= rows.pointsPerRow) return undefined;
  return row * rows.pointsPerRow + pointIndex;
}

function positionOf(rows: TableRows, row: number, pointIndex: number) {
  const start = (row * rows.pointsPerRow + pointIndex) * rows.rank;
  return rows.positions.slice(start, start + rows.rank);
}

export function rootsOfRow(rows: TableRows, row: number): BigUint64Array {
  return rows.roots.subarray(rows.rootOffsets[row], rows.rootOffsets[row + 1]);
}

export function annotationOfInstance(
  rows: TableRows,
  instance: number,
): Annotation {
  const row = rowOfInstance(rows, instance);
  const common = {
    id: instanceId(rows, instance),
    properties: [rows.values[row]],
    relatedSegments: [rootsOfRow(rows, row).slice()],
  };
  if (rows.type === AnnotationType.LINE) {
    return {
      ...common,
      type: AnnotationType.LINE,
      pointA: positionOf(rows, row, 0),
      pointB: positionOf(rows, row, 1),
    };
  }
  return {
    ...common,
    type: AnnotationType.POINT,
    point: positionOf(rows, row, instance % rows.pointsPerRow),
  };
}

/** Every response row, in the order the responses list them. */
interface Occurrences {
  responseIndex: Uint32Array;
  rowIndex: Uint32Array;
  rowIds: BigUint64Array;
}

function gatherOccurrences(responses: readonly TablePoints[]): Occurrences {
  const total = responses.reduce((sum, points) => sum + points.ids.length, 0);
  const occurrences: Occurrences = {
    responseIndex: new Uint32Array(total),
    rowIndex: new Uint32Array(total),
    rowIds: new BigUint64Array(total),
  };
  let next = 0;
  responses.forEach((points, responseIndex) => {
    points.ids.forEach((rowId, rowIndex) => {
      occurrences.responseIndex[next] = responseIndex;
      occurrences.rowIndex[next] = rowIndex;
      occurrences.rowIds[next] = rowId;
      ++next;
    });
  });
  return occurrences;
}

const WORDS_PER_ROW_ID = 2;
const LOW_WORD = ENDIANNESS === Endianness.LITTLE ? 0 : 1;
const HIGH_WORD = 1 - LOW_WORD;

/** The 32-bit halves of row ids, compared without reading a bigint. */
function rowIdWords(rowIds: BigUint64Array): Uint32Array {
  return new Uint32Array(
    rowIds.buffer,
    rowIds.byteOffset,
    rowIds.length * WORDS_PER_ROW_ID,
  );
}

function compareRowIds(words: Uint32Array, a: number, b: number): number {
  const highDifference =
    words[a * WORDS_PER_ROW_ID + HIGH_WORD] -
    words[b * WORDS_PER_ROW_ID + HIGH_WORD];
  if (highDifference !== 0) return highDifference;
  return (
    words[a * WORDS_PER_ROW_ID + LOW_WORD] -
    words[b * WORDS_PER_ROW_ID + LOW_WORD]
  );
}

// Hot path (1M rows): argsort by row id without a per-row object; ties keep response order.
function sortByRowId(words: Uint32Array, total: number): Uint32Array {
  const order = new Uint32Array(total);
  let ascending = true;
  for (let i = 0; i < total; ++i) {
    order[i] = i;
    if (i > 0 && compareRowIds(words, i - 1, i) >= 0) ascending = false;
  }
  if (ascending) return order;
  return order.sort((a, b) => compareRowIds(words, a, b) || a - b);
}

/** Start of each distinct row id in `order`, plus the end. */
function rowStarts(words: Uint32Array, order: Uint32Array): Uint32Array {
  const starts = new Uint32Array(order.length + 1);
  let count = 0;
  for (let i = 0; i < order.length; ++i) {
    if (i === 0 || compareRowIds(words, order[i], order[i - 1]) !== 0) {
      starts[count++] = i;
    }
  }
  starts[count++] = order.length;
  return starts.slice(0, count);
}

function relatedRootsOf(
  responses: readonly FetchedTablePoints[],
  occurrences: Occurrences,
  order: Uint32Array,
  starts: Uint32Array,
) {
  const rowTotal = starts.length - 1;
  const rootOffsets = new Uint32Array(rowTotal + 1);
  const capacity = order.length * Math.max(1, maxPointCount(responses));
  const roots = new BigUint64Array(capacity);
  let written = 0;
  const addRoot = (rowStart: number, root: bigint) => {
    for (let i = rowStart; i < written; ++i) if (roots[i] === root) return;
    roots[written++] = root;
  };
  for (let row = 0; row < rowTotal; ++row) {
    const rowStart = written;
    for (let k = starts[row]; k < starts[row + 1]; ++k) {
      const occurrence = order[k];
      const { fetchedUnder, points } =
        responses[occurrences.responseIndex[occurrence]];
      const index = occurrences.rowIndex[occurrence];
      let bound = false;
      for (const { rootIndex } of points.points) {
        const pointRootIndex = rootIndex[index];
        if (pointRootIndex === UNBOUND_ROOT_INDEX) continue;
        bound = true;
        addRoot(rowStart, points.roots[pointRootIndex]);
      }
      if (!bound && fetchedUnder !== undefined) addRoot(rowStart, fetchedUnder);
    }
    rootOffsets[row + 1] = written;
  }
  return { rootOffsets, roots: roots.subarray(0, written) };
}

function maxPointCount(responses: readonly FetchedTablePoints[]) {
  return Math.max(0, ...responses.map(({ points }) => points.points.length));
}

// Hot path (1M rows): voxel → source units straight into the column, no per-point array.
function writePositions(
  target: Float32Array,
  targetOffset: number,
  points: TablePoints,
  index: number,
  unitsPerVoxel: readonly number[],
  rank: number,
) {
  let offset = targetOffset;
  for (const { positions } of points.points) {
    const voxelOffset = index * COORDINATES_PER_POSITION;
    for (let dim = 0; dim < COORDINATES_PER_POSITION; ++dim) {
      target[offset + dim] = positions[voxelOffset + dim] * unitsPerVoxel[dim];
    }
    offset += rank;
  }
}

/**
 * Each row once across responses, in ascending id: the value and positions of
 * its first response, related to the roots of every response. A response
 * fetched for the whole table has no `fetchedUnder`.
 */
export function buildTableRows(
  tables: Iterable<FetchedTablePoints>,
  table: AnnotationTableInfo,
  scale: SourceScale,
): TableRows {
  const fetched = [...tables];
  const pointsPerRow = maxPointCount(fetched);
  if (pointsPerRow === 0) return EMPTY_TABLE_ROWS(table.name);
  const responses = fetched.filter(
    ({ points }) => points.points.length === pointsPerRow,
  );
  const occurrences = gatherOccurrences(responses.map(({ points }) => points));
  const occurrenceWords = rowIdWords(occurrences.rowIds);
  const order = sortByRowId(occurrenceWords, occurrences.rowIds.length);
  const starts = rowStarts(occurrenceWords, order);
  const rowTotal = starts.length - 1;
  const { rank } = scale;
  const unitsPerVoxel = table.voxelResolution.map(
    (resolution, dim) => resolution / scale.nanometresPerUnit[dim],
  );
  const rowIds = new BigUint64Array(rowTotal);
  const words = rowIdWords(rowIds);
  const values = new Float64Array(rowTotal);
  const positions = new Float32Array(rowTotal * pointsPerRow * rank);
  for (let row = 0; row < rowTotal; ++row) {
    const first = order[starts[row]];
    const { points } = responses[occurrences.responseIndex[first]];
    const index = occurrences.rowIndex[first];
    words[row * WORDS_PER_ROW_ID] = occurrenceWords[first * WORDS_PER_ROW_ID];
    words[row * WORDS_PER_ROW_ID + 1] =
      occurrenceWords[first * WORDS_PER_ROW_ID + 1];
    values[row] = points.values[index];
    writePositions(
      positions,
      row * pointsPerRow * rank,
      points,
      index,
      unitsPerVoxel,
      rank,
    );
  }
  return {
    table: table.name,
    type:
      pointsPerRow === LINE_POINT_COUNT
        ? AnnotationType.LINE
        : AnnotationType.POINT,
    pointsPerRow,
    rank,
    rowIds,
    values,
    positions,
    ...relatedRootsOf(responses, occurrences, order, starts),
  };
}

function withoutSlice<
  T extends BigUint64Array | Float64Array | Float32Array | Uint32Array,
>(column: T, start: number, end: number): T {
  const remaining = new (column.constructor as new (length: number) => T)(
    column.length - (end - start),
  );
  remaining.set(column.subarray(0, start) as never);
  remaining.set(column.subarray(end) as never, start);
  return remaining;
}

/** The same rows without `row`. */
export function withoutRow(rows: TableRows, row: number): TableRows {
  const positionStride = rows.pointsPerRow * rows.rank;
  const rootStart = rows.rootOffsets[row];
  const rootEnd = rows.rootOffsets[row + 1];
  const rootOffsets = withoutSlice(rows.rootOffsets, row + 1, row + 2);
  for (let i = row + 1; i < rootOffsets.length; ++i) {
    rootOffsets[i] -= rootEnd - rootStart;
  }
  return {
    ...rows,
    rowIds: withoutSlice(rows.rowIds, row, row + 1),
    values: withoutSlice(rows.values, row, row + 1),
    positions: withoutSlice(
      rows.positions,
      row * positionStride,
      (row + 1) * positionStride,
    ),
    rootOffsets,
    roots: withoutSlice(rows.roots, rootStart, rootEnd),
  };
}

export function firstInstanceOfRow(rows: TableRows, row: number): number {
  return row * instancesPerRow(rows);
}
