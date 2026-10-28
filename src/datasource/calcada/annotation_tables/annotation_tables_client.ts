/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { appendCoordParams } from "#src/datasource/calcada/graph_coordinates.js";
import type { FetchOk } from "#src/util/http_request.js";
import { HttpError } from "#src/util/http_request.js";
import {
  expectArray,
  parseUint64,
  verifyFiniteFloat,
  verifyNonnegativeInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";

/** CAVE filter dicts by operator, e.g. `filter_equal_dict: { kind: "x" }`. */
export type AnnotationTableFilter = Record<string, Record<string, unknown>>;

export const ANNOTATION_FILTER_OPERATORS = [
  "filter_in_dict",
  "filter_notin_dict",
  "filter_equal_dict",
  "filter_greater_dict",
  "filter_less_dict",
  "filter_greater_equal_dict",
  "filter_less_equal_dict",
  "filter_regex_dict",
] as const;

export const ANNOTATION_PROPERTY_TYPES = [
  "number",
  "integer",
  "string",
  "boolean",
] as const;
export type AnnotationPropertyType = (typeof ANNOTATION_PROPERTY_TYPES)[number];

export interface AnnotationTableInfo {
  name: string;
  schemaName: string;
  schemaVersion: number;
  description: string;
  voxelResolution: [number, number, number];
  points: string[];
  properties: Record<string, AnnotationPropertyType>;
}

export interface SegmentAnnotationPoint {
  name: string;
  position: [number, number, number];
  pieceId: bigint;
  rootId: bigint;
}

export interface SegmentAnnotation {
  id: bigint;
  value: number;
  payload: Record<string, unknown>;
  points: SegmentAnnotationPoint[];
}

/** The server's cap on the tables one segment request may name. */
export const MAX_TABLES_PER_SEGMENT_REQUEST = 20;

export interface SegmentTableAnnotations {
  annotations: SegmentAnnotation[];
  nextCursor?: string;
}

export interface SegmentAnnotations {
  rootId: bigint;
  tables: Map<string, SegmentTableAnnotations>;
}

export interface AnnotationTableQuery {
  table: AnnotationTableInfo;
  filter?: AnnotationTableFilter;
  afterId?: string;
  limit: number;
}

interface AnnotationSchema {
  points: string[];
  properties: Record<string, AnnotationPropertyType>;
}

export type SchemaCache = Map<string, Promise<AnnotationSchema>>;

export class AnnotationTableForbidden extends Error {
  constructor(readonly table: string) {
    super(`No read permission on annotation table ${table}`);
    this.name = "AnnotationTableForbidden";
  }
}

export class AnnotationTableMissing extends Error {
  constructor(readonly table: string) {
    super(`Annotation table ${table} not found`);
    this.name = "AnnotationTableMissing";
  }
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const QUOTED_TABLE_NAME = /annotation table "([^"]+)"/;

async function errorTableName(
  error: HttpError,
  requested: string[],
): Promise<string> {
  try {
    const body = await error.response?.json();
    const named = QUOTED_TABLE_NAME.exec(body?.message ?? body?.error ?? "");
    if (named) return named[1];
  } catch {
    // The body is not the server's JSON error; the whole request is at fault.
  }
  return requested.join(",");
}

function parseVec3(value: unknown): [number, number, number] {
  const array = expectArray(value, 3);
  return [
    verifyFiniteFloat(array[0]),
    verifyFiniteFloat(array[1]),
    verifyFiniteFloat(array[2]),
  ];
}

function schemaKey(schemaName: string, version: number) {
  return `${schemaName}@${version}`;
}

function propertyType(definition: unknown): AnnotationPropertyType | undefined {
  const type = verifyOptionalObjectProperty(definition, "type", (v) => v);
  const declared: unknown[] = Array.isArray(type) ? type : [type];
  return ANNOTATION_PROPERTY_TYPES.find((known) => declared.includes(known));
}

function parseSchemaProperties(
  jsonSchema: unknown,
): Record<string, AnnotationPropertyType> {
  const definitions = verifyOptionalObjectProperty(
    jsonSchema,
    "properties",
    verifyObject,
    {},
  );
  const properties: Record<string, AnnotationPropertyType> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const type = propertyType(verifyObject(definition));
    if (type !== undefined) properties[name] = type;
  }
  return properties;
}

function parseSchema(body: unknown): AnnotationSchema {
  const roles = expectArray(verifyObjectProperty(body, "points", (v) => v)).map(
    (p) => ({
      name: verifyObjectProperty(p, "name", verifyString),
      role: verifyObjectProperty(p, "role", verifyNonnegativeInt),
    }),
  );
  return {
    points: roles.sort((a, b) => a.role - b.role).map((p) => p.name),
    properties: verifyOptionalObjectProperty(
      body,
      "json_schema",
      parseSchemaProperties,
      {},
    ),
  };
}

function schemaDefinition(
  fetchOk: FetchOk,
  baseUrl: string,
  schemaName: string,
  version: number,
  cache: SchemaCache,
): Promise<AnnotationSchema> {
  const key = schemaKey(schemaName, version);
  let schema = cache.get(key);
  if (schema === undefined) {
    schema = fetchOk(
      `${baseUrl}/annotation/schemas/${encodeURIComponent(schemaName)}?version=${version}`,
    )
      .then((response) => response.json())
      .then(parseSchema);
    cache.set(key, schema);
    schema.catch(() => cache.delete(key));
  }
  return schema;
}

/** The first call commonly races the middleauth token handshake and 401s. */
export async function retryOnceIfUnauthorized<T>(
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof HttpError && error.status === HTTP_UNAUTHORIZED) {
      return attempt();
    }
    throw error;
  }
}

export async function listAnnotationTables(
  fetchOk: FetchOk,
  baseUrl: string,
  cache: SchemaCache = new Map(),
): Promise<AnnotationTableInfo[]> {
  const body = await fetchOk(`${baseUrl}/annotation/tables`).then((response) =>
    response.json(),
  );
  const rows = expectArray(verifyObjectProperty(body, "tables", (v) => v));
  // A reference table annotates another table's rows and has no points.
  const pointTables = rows.filter(
    (row) => verifyObjectProperty(row, "reference_table", verifyString) === "",
  );
  return Promise.all(
    pointTables.map(async (row) => {
      const schemaName = verifyObjectProperty(row, "schema_type", verifyString);
      const schemaVersion = verifyObjectProperty(
        row,
        "schema_version",
        verifyNonnegativeInt,
      );
      const { points, properties } = await schemaDefinition(
        fetchOk,
        baseUrl,
        schemaName,
        schemaVersion,
        cache,
      );
      return {
        name: verifyObjectProperty(row, "table_name", verifyString),
        schemaName,
        schemaVersion,
        description: verifyObjectProperty(row, "description", verifyString),
        voxelResolution: [
          verifyObjectProperty(row, "voxel_resolution_x", verifyFiniteFloat),
          verifyObjectProperty(row, "voxel_resolution_y", verifyFiniteFloat),
          verifyObjectProperty(row, "voxel_resolution_z", verifyFiniteFloat),
        ],
        points,
        properties,
      };
    }),
  );
}

async function parseAnnotation(
  row: unknown,
  table: AnnotationTableInfo,
  fetchOk: FetchOk,
  baseUrl: string,
  cache: SchemaCache,
): Promise<SegmentAnnotation> {
  const version = verifyObjectProperty(
    row,
    "schema_version",
    verifyNonnegativeInt,
  );
  const roles =
    version === table.schemaVersion
      ? table.points
      : (
          await schemaDefinition(
            fetchOk,
            baseUrl,
            table.schemaName,
            version,
            cache,
          )
        ).points;
  const rowPoints = verifyObjectProperty(row, "points", verifyObject);
  const unknown = Object.keys(rowPoints).filter((n) => !roles.includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `Annotation point ${unknown[0]} is not in schema ${table.schemaName} v${version}`,
    );
  }
  return {
    id: verifyObjectProperty(row, "id", parseUint64),
    value: verifyObjectProperty(row, "value", verifyFiniteFloat),
    payload: verifyObjectProperty(row, "payload", verifyObject),
    points: roles
      .filter((name) => name in rowPoints)
      .map((name) => {
        const point = verifyObjectProperty(rowPoints, name, verifyObject);
        const rootId = point.root_id;
        return {
          name,
          position: verifyObjectProperty(point, "position", parseVec3),
          pieceId: verifyObjectProperty(point, "piece_id", parseUint64),
          rootId: rootId === undefined ? 0n : parseUint64(rootId),
        };
      }),
  };
}

function queryBody({ filter, afterId, limit }: AnnotationTableQuery) {
  return {
    ...filter,
    ...(afterId === undefined ? {} : { after_id: afterId }),
    limit,
  };
}

function parseNextCursor(cursor: unknown): string {
  return verifyObjectProperty(cursor, "after_id", verifyString);
}

export async function fetchSegmentAnnotations(
  fetchOk: FetchOk,
  baseUrl: string,
  root: bigint,
  queries: AnnotationTableQuery[],
  coords: { branchId: number; timestamp: number },
  cache: SchemaCache = new Map(),
): Promise<SegmentAnnotations> {
  if (queries.length === 0) return { rootId: root, tables: new Map() };
  const names = queries.map(({ table }) => table.name);
  const url = appendCoordParams(
    `${baseUrl}/annotation/segment/${root}/annotations?int64_as_str=1`,
    coords,
  );
  let body: unknown;
  try {
    body = await fetchOk(url, {
      method: "POST",
      body: JSON.stringify({
        tables: Object.fromEntries(
          queries.map((query) => [query.table.name, queryBody(query)]),
        ),
      }),
    }).then((response) => response.json());
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === HTTP_FORBIDDEN) {
        throw new AnnotationTableForbidden(await errorTableName(error, names));
      }
      if (error.status === HTTP_NOT_FOUND) {
        throw new AnnotationTableMissing(await errorTableName(error, names));
      }
    }
    throw error;
  }
  const rawTables = verifyObjectProperty(body, "tables", verifyObject);
  const result: SegmentAnnotations = {
    rootId: verifyObjectProperty(body, "root_id", parseUint64),
    tables: new Map(),
  };
  for (const { table } of queries) {
    const raw = rawTables[table.name];
    if (raw === undefined) continue;
    const rows = expectArray(
      verifyObjectProperty(raw, "annotations", (v) => v),
    );
    const nextCursor = verifyOptionalObjectProperty(
      raw,
      "next_cursor",
      parseNextCursor,
    );
    result.tables.set(table.name, {
      annotations: await Promise.all(
        rows.map((row) => parseAnnotation(row, table, fetchOk, baseUrl, cache)),
      ),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  }
  return result;
}
