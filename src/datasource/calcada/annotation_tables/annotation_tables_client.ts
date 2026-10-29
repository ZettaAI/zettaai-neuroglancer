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
  verifyBoolean,
  verifyFiniteFloat,
  verifyInt,
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
  canWrite: boolean;
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

export interface AnnotationTableQuery {
  table: AnnotationTableInfo;
  filter?: AnnotationTableFilter;
}

export interface AnnotationReadCoordinates {
  branchId: number;
  timestamp: number;
}

export const UNBOUND_ROOT_INDEX = -1;

export interface TablePointColumn {
  name: string;
  positions: Int32Array;
  rootIndex: Int32Array;
}

export interface TablePoints {
  ids: bigint[];
  values: Float64Array;
  roots: bigint[];
  points: TablePointColumn[];
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
const UNNAMED_TABLE_MISSING = "annotation table not found";

async function errorMessageOf(error: HttpError): Promise<string> {
  try {
    const body = await error.response?.json();
    return body?.message ?? body?.error ?? "";
  } catch {
    // Not the server's JSON error, e.g. a route this server does not have.
    return "";
  }
}

function namedTable(message: string): string | undefined {
  return QUOTED_TABLE_NAME.exec(message)?.[1];
}

/**
 * A 404 is a missing table only when the server says so; any other 404, such
 * as a route an older server lacks, is an ordinary failure.
 */
function missingTable(
  message: string,
  requested: string[],
): string | undefined {
  if (message === UNNAMED_TABLE_MISSING) return requested.join(",");
  return namedTable(message);
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
        // Older servers send no access; they then allow no delete here.
        canWrite: verifyOptionalObjectProperty(
          row,
          "access",
          (access) => verifyObjectProperty(access, "write", verifyBoolean),
          false,
        ),
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

async function fetchTableOk(
  fetchOk: FetchOk,
  url: string,
  init: RequestInit | undefined,
  tableNames: string[],
): Promise<Response> {
  try {
    return await fetchOk(url, init);
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === HTTP_FORBIDDEN) {
        throw new AnnotationTableForbidden(
          namedTable(await errorMessageOf(error)) ?? tableNames.join(","),
        );
      }
      if (error.status === HTTP_NOT_FOUND) {
        const missing = missingTable(await errorMessageOf(error), tableNames);
        if (missing !== undefined) throw new AnnotationTableMissing(missing);
      }
    }
    throw error;
  }
}

async function postForJson(
  fetchOk: FetchOk,
  url: string,
  body: unknown,
  tableNames: string[],
): Promise<unknown> {
  const response = await fetchTableOk(
    fetchOk,
    url,
    { method: "POST", body: JSON.stringify(body) },
    tableNames,
  );
  return response.json();
}

function segmentBody(queries: AnnotationTableQuery[]) {
  return {
    tables: Object.fromEntries(
      queries.map(({ table, filter }) => [table.name, { ...filter }]),
    ),
  };
}

function parseInt32Column(value: unknown): Int32Array {
  return Int32Array.from(expectArray(value), verifyInt);
}

function parseTablePointColumn(column: unknown): TablePointColumn {
  return {
    name: verifyObjectProperty(column, "name", verifyString),
    positions: verifyObjectProperty(column, "positions", parseInt32Column),
    rootIndex: verifyObjectProperty(column, "root_index", parseInt32Column),
  };
}

function requireLength(column: string, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(
      `Points column ${column} has ${actual} entries, expected ${expected}`,
    );
  }
}

function parseTablePoints(raw: unknown): TablePoints {
  const ids = expectArray(verifyObjectProperty(raw, "ids", (v) => v)).map(
    parseUint64,
  );
  const values = Float64Array.from(
    expectArray(verifyObjectProperty(raw, "values", (v) => v)),
    verifyFiniteFloat,
  );
  const roots = expectArray(verifyObjectProperty(raw, "roots", (v) => v)).map(
    parseUint64,
  );
  const points = expectArray(verifyObjectProperty(raw, "points", (v) => v)).map(
    parseTablePointColumn,
  );
  requireLength("values", values.length, ids.length);
  for (const { name, positions, rootIndex } of points) {
    requireLength(`${name}.positions`, positions.length, 3 * ids.length);
    requireLength(`${name}.root_index`, rootIndex.length, ids.length);
    if (
      rootIndex.some(
        (index) => index < UNBOUND_ROOT_INDEX || index >= roots.length,
      )
    ) {
      throw new Error(`Points column ${name}.root_index is out of range`);
    }
  }
  return { ids, values, roots, points };
}

function parseTableCount(raw: unknown): number {
  return verifyObjectProperty(raw, "count", verifyNonnegativeInt);
}

async function postSegmentTables<T>(
  fetchOk: FetchOk,
  baseUrl: string,
  root: bigint,
  endpoint: string,
  queries: AnnotationTableQuery[],
  coords: AnnotationReadCoordinates,
  parseTable: (raw: unknown) => T,
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (queries.length === 0) return result;
  const body = await postForJson(
    fetchOk,
    appendCoordParams(
      `${baseUrl}/annotation/segment/${root}/${endpoint}`,
      coords,
    ),
    segmentBody(queries),
    queries.map(({ table }) => table.name),
  );
  const rawTables = verifyObjectProperty(body, "tables", verifyObject);
  for (const { table } of queries) {
    const raw = rawTables[table.name];
    if (raw !== undefined) result.set(table.name, parseTable(raw));
  }
  return result;
}

async function postTable<T>(
  fetchOk: FetchOk,
  baseUrl: string,
  endpoint: string,
  { table, filter }: AnnotationTableQuery,
  coords: AnnotationReadCoordinates,
  parseBody: (raw: unknown) => T,
): Promise<T> {
  const body = await postForJson(
    fetchOk,
    appendCoordParams(
      `${baseUrl}/annotation/tables/${encodeURIComponent(table.name)}/${endpoint}`,
      coords,
    ),
    { ...filter },
    [table.name],
  );
  return parseBody(body);
}

export function fetchSegmentCounts(
  fetchOk: FetchOk,
  baseUrl: string,
  root: bigint,
  queries: AnnotationTableQuery[],
  coords: AnnotationReadCoordinates,
): Promise<Map<string, number>> {
  return postSegmentTables(
    fetchOk,
    baseUrl,
    root,
    "count",
    queries,
    coords,
    parseTableCount,
  );
}

export function fetchSegmentPoints(
  fetchOk: FetchOk,
  baseUrl: string,
  root: bigint,
  queries: AnnotationTableQuery[],
  coords: AnnotationReadCoordinates,
): Promise<Map<string, TablePoints>> {
  return postSegmentTables(
    fetchOk,
    baseUrl,
    root,
    "points",
    queries,
    coords,
    parseTablePoints,
  );
}

export function fetchTableCount(
  fetchOk: FetchOk,
  baseUrl: string,
  query: AnnotationTableQuery,
  coords: AnnotationReadCoordinates,
): Promise<number> {
  return postTable(fetchOk, baseUrl, "count", query, coords, parseTableCount);
}

export function fetchTablePoints(
  fetchOk: FetchOk,
  baseUrl: string,
  query: AnnotationTableQuery,
  coords: AnnotationReadCoordinates,
): Promise<TablePoints> {
  return postTable(fetchOk, baseUrl, "points", query, coords, parseTablePoints);
}

export async function fetchAnnotationRows(
  fetchOk: FetchOk,
  baseUrl: string,
  table: AnnotationTableInfo,
  ids: bigint[],
  coords: AnnotationReadCoordinates,
  cache: SchemaCache = new Map(),
): Promise<SegmentAnnotation[]> {
  if (ids.length === 0) return [];
  const url = appendCoordParams(
    `${baseUrl}/annotation/tables/${encodeURIComponent(table.name)}/annotations?int64_as_str=1&ids=${ids.join(",")}`,
    coords,
  );
  const body = await fetchTableOk(fetchOk, url, undefined, [table.name]).then(
    (response) => response.json(),
  );
  const rows = expectArray(verifyObjectProperty(body, "annotations", (v) => v));
  return Promise.all(
    rows.map((row) => parseAnnotation(row, table, fetchOk, baseUrl, cache)),
  );
}

export async function deleteAnnotationRows(
  fetchOk: FetchOk,
  baseUrl: string,
  table: string,
  ids: bigint[],
): Promise<void> {
  await fetchTableOk(
    fetchOk,
    `${baseUrl}/annotation/tables/${encodeURIComponent(table)}/annotations`,
    { method: "DELETE", body: JSON.stringify({ ids: ids.map(String) }) },
    [table],
  );
}
