/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  Annotation,
  AnnotationIdsByIndex,
  AnnotationIndexById,
  AnnotationPropertySerializer,
  Line,
  Point,
  RenderedAnnotations,
} from "#src/annotation/index.js";
import {
  AnnotationType,
  annotationTypeHandlers,
  annotationTypes,
} from "#src/annotation/index.js";
import type { TableRows } from "#src/datasource/calcada/annotation_tables/table_rows.js";
import {
  instanceCount,
  instanceId,
  instanceOfId,
  rowOfInstance,
} from "#src/datasource/calcada/annotation_tables/table_rows.js";
import { Endianness, ENDIANNESS } from "#src/util/endian.js";

const IS_LITTLE_ENDIAN = ENDIANNESS === Endianness.LITTLE;

/** One reused annotation per table type, refilled for every row it serializes. */
function scratchAnnotation(
  type: TableRows["type"],
  rank: number,
): Point | Line {
  const common = { id: "", properties: [0] };
  if (type === AnnotationType.LINE) {
    return {
      ...common,
      type,
      pointA: new Float32Array(rank),
      pointB: new Float32Array(rank),
    };
  }
  return { ...common, type, point: new Float32Array(rank) };
}

// Hot path (1M rows): copies one point of the positions column, zero past the rows' rank.
function fillPoint(target: Float32Array, rows: TableRows, pointOffset: number) {
  for (let dim = 0; dim < target.length; ++dim) {
    target[dim] = dim < rows.rank ? rows.positions[pointOffset + dim] : 0;
  }
}

function fillScratch(scratch: Point | Line, rows: TableRows, instance: number) {
  const row = rowOfInstance(rows, instance);
  scratch.properties[0] = rows.values[row];
  if (scratch.type === AnnotationType.LINE) {
    const rowOffset = row * rows.pointsPerRow * rows.rank;
    fillPoint(scratch.pointA, rows, rowOffset);
    fillPoint(scratch.pointB, rows, rowOffset + rows.rank);
  } else {
    fillPoint(scratch.point, rows, instance * rows.rank);
  }
}

function idsOf(
  rows: TableRows | undefined,
  placed: readonly Annotation[],
): AnnotationIdsByIndex {
  const rowInstances = rows === undefined ? 0 : instanceCount(rows);
  return {
    length: rowInstances + placed.length,
    at: (index) =>
      index < rowInstances
        ? instanceId(rows!, index)
        : placed[index - rowInstances]?.id,
  };
}

function indicesOf(
  rows: TableRows | undefined,
  placed: readonly Annotation[],
): AnnotationIndexById {
  const rowInstances = rows === undefined ? 0 : instanceCount(rows);
  const placedIndex = new Map(placed.map(({ id }, index) => [id, index]));
  return {
    get: (id) => {
      const instance = rows === undefined ? undefined : instanceOfId(rows, id);
      if (instance !== undefined) return instance;
      const index = placedIndex.get(id);
      return index === undefined ? undefined : rowInstances + index;
    },
  };
}

/**
 * NG's render buffer for a table's rows followed by annotations placed in it,
 * written straight from the columns: one scratch annotation, no object per row.
 * Placed annotations are points and lines only.
 */
export function serializeTableRows(
  rows: TableRows,
  placed: readonly Annotation[],
  propertySerializers: AnnotationPropertySerializer[],
): RenderedAnnotations {
  const placedByType = annotationTypes.map((type) =>
    placed.filter((annotation) => annotation.type === type),
  );
  const rowsOfType = (type: AnnotationType) =>
    type === rows.type ? rows : undefined;
  const typeToSize = annotationTypes.map(
    (type) =>
      (type === rows.type ? instanceCount(rows) : 0) +
      placedByType[type].length,
  );
  const typeToOffset: number[] = [];
  let totalBytes = 0;
  for (const type of annotationTypes) {
    typeToOffset[type] = totalBytes;
    totalBytes += propertySerializers[type].serializedBytes * typeToSize[type];
  }
  const data = new Uint8Array(totalBytes);
  const dataView = new DataView(data.buffer);
  for (const type of annotationTypes) {
    const count = typeToSize[type];
    if (count === 0) continue;
    const propertySerializer = propertySerializers[type];
    const { rank } = propertySerializer;
    const instanceStride = propertySerializer.propertyGroupBytes[0];
    const offset = typeToOffset[type];
    const { serialize } = annotationTypeHandlers[type];
    const write = (annotation: Annotation, index: number) => {
      serialize(
        dataView,
        offset + index * instanceStride,
        IS_LITTLE_ENDIAN,
        rank,
        annotation,
        instanceStride,
      );
      propertySerializer.serialize(
        dataView,
        offset,
        index,
        count,
        IS_LITTLE_ENDIAN,
        annotation.properties,
      );
    };
    const rowInstances = type === rows.type ? instanceCount(rows) : 0;
    if (rowInstances > 0) {
      const scratch = scratchAnnotation(rows.type, rank);
      for (let instance = 0; instance < rowInstances; ++instance) {
        fillScratch(scratch, rows, instance);
        write(scratch, instance);
      }
    }
    placedByType[type].forEach((annotation, index) =>
      write(annotation, rowInstances + index),
    );
  }
  return {
    data,
    typeToSize,
    typeToOffset,
    typeToInstanceCounts: annotationTypes.map(() => []),
    typeToIds: annotationTypes.map((type) =>
      idsOf(rowsOfType(type), placedByType[type]),
    ),
    typeToIdMaps: annotationTypes.map((type) =>
      indicesOf(rowsOfType(type), placedByType[type]),
    ),
  };
}
