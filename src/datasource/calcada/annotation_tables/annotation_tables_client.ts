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
  verifyNonnegativeInt,
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";

export interface AnnotationTableInfo {
  name: string;
  schemaName: string;
  schemaVersion: number;
  description: string;
  voxelResolution: [number, number, number];
  points: string[];
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

/** The server's cap on one segment's annotations in one table. */
export const MAX_ANNOTATIONS_PER_SEGMENT = 10_000;
/** The server's cap on the tables one segment request may name. */
export const MAX_TABLES_PER_SEGMENT_REQUEST = 20;

export interface SegmentAnnotations {
  rootId: bigint;
  tables: Map<string, { annotations: SegmentAnnotation[]; truncated: boolean }>;
}

export type SchemaPointsCache = Map<string, Promise<string[]>>;

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

function schemaPoints(
  fetchOk: FetchOk,
  baseUrl: string,
  schemaName: string,
  version: number,
  cache: SchemaPointsCache,
): Promise<string[]> {
  const key = schemaKey(schemaName, version);
  let points = cache.get(key);
  if (points === undefined) {
    points = fetchOk(
      `${baseUrl}/annotation/schemas/${encodeURIComponent(schemaName)}?version=${version}`,
    )
      .then((response) => response.json())
      .then((body) => {
        const roles = expectArray(
          verifyObjectProperty(body, "points", (v) => v),
        ).map((p) => ({
          name: verifyObjectProperty(p, "name", verifyString),
          role: verifyObjectProperty(p, "role", verifyNonnegativeInt),
        }));
        return roles.sort((a, b) => a.role - b.role).map((p) => p.name);
      });
    cache.set(key, points);
    points.catch(() => cache.delete(key));
  }
  return points;
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
  cache: SchemaPointsCache = new Map(),
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
        points: await schemaPoints(
          fetchOk,
          baseUrl,
          schemaName,
          schemaVersion,
          cache,
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
  cache: SchemaPointsCache,
): Promise<SegmentAnnotation> {
  const version = verifyObjectProperty(
    row,
    "schema_version",
    verifyNonnegativeInt,
  );
  const roles =
    version === table.schemaVersion
      ? table.points
      : await schemaPoints(fetchOk, baseUrl, table.schemaName, version, cache);
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

export async function fetchSegmentAnnotations(
  fetchOk: FetchOk,
  baseUrl: string,
  root: bigint,
  tables: AnnotationTableInfo[],
  coords: { branchId: number; timestamp: number },
  cache: SchemaPointsCache = new Map(),
): Promise<SegmentAnnotations> {
  if (tables.length === 0) return { rootId: root, tables: new Map() };
  const names = tables.map((t) => t.name);
  const tablesParam = names.map(encodeURIComponent).join(",");
  const url = appendCoordParams(
    `${baseUrl}/annotation/segment/${root}/annotations?int64_as_str=1&tables=${tablesParam}`,
    coords,
  );
  let body: unknown;
  try {
    body = await fetchOk(url).then((response) => response.json());
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
  for (const table of tables) {
    const raw = rawTables[table.name];
    if (raw === undefined) continue;
    const rows = expectArray(
      verifyObjectProperty(raw, "annotations", (v) => v),
    );
    result.tables.set(table.name, {
      annotations: await Promise.all(
        rows.map((row) => parseAnnotation(row, table, fetchOk, baseUrl, cache)),
      ),
      truncated: verifyObjectProperty(raw, "truncated", verifyBoolean),
    });
  }
  return result;
}
