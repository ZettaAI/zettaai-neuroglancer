/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AnnotationTableInfo } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import {
  createAnnotationRow,
  createAnnotationTable,
  deleteAnnotationRows,
  listAnnotationTables,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { CalcadaAnnotationTablesSession } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { nanometresToTableVoxels } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import type { TraceDecision } from "#src/datasource/calcada/trace_end_check.js";
import type { FetchOk } from "#src/util/http_request.js";

export type TraceEndStatus = "certain" | "uncertain";

/** One table per status, so each can be shown in its own colour. */
export const TRACE_ENDPOINTS_TABLES: Record<TraceEndStatus, string> = {
  certain: "trace_endpoints_certain",
  uncertain: "trace_endpoints_uncertain",
};
const TRACE_ENDPOINTS_DESCRIPTIONS: Record<TraceEndStatus, string> = {
  certain: "Trace ends marked certain",
  uncertain: "Trace ends marked uncertain",
};
export const TRACE_ENDPOINT_SCHEMA = "trace_endpoint";
const TRACE_ENDPOINT_SCHEMA_VERSION = 1;
const TRACE_ENDPOINT_POINT = "pt";

export interface TraceEndpointRow {
  status: TraceEndStatus;
  threshold: number;
  radiusNm: number;
  /** Both absent for an end asked for at the seed sphere, before any decision. */
  after?: TraceDecision;
  lineId?: bigint;
  /** In global coordinates. */
  position: Float32Array;
}

interface TraceEndpointTableOptions {
  fetchOk: FetchOk;
  baseUrl: string;
  toNanometres: (point: Float32Array) => Float32Array | undefined;
  nanometresPerUnit: () => readonly number[] | undefined;
  tablesSession: Pick<
    CalcadaAnnotationTablesSession,
    "rowWritten" | "rowRemoved"
  >;
}

export class TraceEndpointTable {
  private readonly ensured = new Map<
    TraceEndStatus,
    Promise<AnnotationTableInfo>
  >();

  constructor(private readonly options: TraceEndpointTableOptions) {}

  async write(branchId: number, row: TraceEndpointRow): Promise<bigint> {
    const { fetchOk, baseUrl, toNanometres, tablesSession } = this.options;
    const nanometres = toNanometres(row.position);
    if (nanometres === undefined) {
      throw new Error("The trace end has no position in nanometres");
    }
    const tableName = TRACE_ENDPOINTS_TABLES[row.status];
    const info = await this.ensureTable(row.status);
    const rowId = await createAnnotationRow(
      fetchOk,
      baseUrl,
      tableName,
      branchId,
      new Map([
        [
          TRACE_ENDPOINT_POINT,
          nanometresToTableVoxels(Array.from(nanometres), info.voxelResolution),
        ],
      ]),
      {
        status: row.status,
        threshold: row.threshold,
        radius_nm: row.radiusNm,
        ...(row.after !== undefined && { after: row.after }),
        ...(row.lineId !== undefined && { line_id: String(row.lineId) }),
      },
    );
    tablesSession.rowWritten(tableName, rowId);
    return rowId;
  }

  async remove(
    branchId: number,
    status: TraceEndStatus,
    rowId: bigint,
  ): Promise<void> {
    const { fetchOk, baseUrl, tablesSession } = this.options;
    const tableName = TRACE_ENDPOINTS_TABLES[status];
    await deleteAnnotationRows(fetchOk, baseUrl, tableName, branchId, [rowId]);
    tablesSession.rowRemoved(tableName, rowId);
  }

  private ensureTable(status: TraceEndStatus): Promise<AnnotationTableInfo> {
    const known = this.ensured.get(status);
    if (known !== undefined) return known;
    const ensuring = this.findOrCreateTable(status);
    this.ensured.set(status, ensuring);
    ensuring.catch(() => {
      if (this.ensured.get(status) === ensuring) this.ensured.delete(status);
    });
    return ensuring;
  }

  private async findOrCreateTable(
    status: TraceEndStatus,
  ): Promise<AnnotationTableInfo> {
    const tableName = TRACE_ENDPOINTS_TABLES[status];
    const found = await this.findTable(tableName);
    if (found !== undefined) return found;
    const { fetchOk, baseUrl, nanometresPerUnit } = this.options;
    const voxelResolution = nanometresPerUnit();
    if (voxelResolution === undefined) {
      throw new Error("The graph has no nanometre scale");
    }
    await createAnnotationTable(fetchOk, baseUrl, {
      tableName,
      schemaType: TRACE_ENDPOINT_SCHEMA,
      schemaVersion: TRACE_ENDPOINT_SCHEMA_VERSION,
      voxelResolution,
      description: TRACE_ENDPOINTS_DESCRIPTIONS[status],
      readPermission: "PUBLIC",
      writePermission: "PUBLIC",
    });
    const created = await this.findTable(tableName);
    if (created === undefined) {
      throw new Error(
        `Annotation table ${tableName} is missing after it was created`,
      );
    }
    return created;
  }

  private async findTable(
    tableName: string,
  ): Promise<AnnotationTableInfo | undefined> {
    const { fetchOk, baseUrl } = this.options;
    const tables = await listAnnotationTables(fetchOk, baseUrl);
    return tables.find(({ name }) => name === tableName);
  }
}
