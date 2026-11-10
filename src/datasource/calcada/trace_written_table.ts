/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file An annotation table the trace writes to, created on its first write
 * with public read and write.
 */

import type {
  AnnotationPayload,
  AnnotationTableInfo,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import {
  createAnnotationRow,
  createAnnotationTable,
  deleteAnnotationRows,
  listAnnotationTables,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { CalcadaAnnotationTablesSession } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { nanometresToTableVoxels } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import type { FetchOk } from "#src/util/http_request.js";

export interface TraceTableOptions {
  fetchOk: FetchOk;
  baseUrl: string;
  toNanometres: (point: Float32Array) => Float32Array | undefined;
  nanometresPerUnit: () => readonly number[] | undefined;
  tablesSession: Pick<
    CalcadaAnnotationTablesSession,
    "rowWritten" | "rowRemoved"
  >;
}

export interface TraceTableSpec {
  name: string;
  schema: string;
  schemaVersion: number;
  description: string;
}

export class TraceWrittenTable {
  private ensured: Promise<AnnotationTableInfo> | undefined;

  constructor(
    private readonly options: TraceTableOptions,
    readonly spec: TraceTableSpec,
  ) {}

  /** `points` are in global coordinates. */
  async write(
    branchId: number,
    points: ReadonlyMap<string, Float32Array>,
    payload: AnnotationPayload,
  ): Promise<bigint> {
    const { fetchOk, baseUrl, toNanometres, tablesSession } = this.options;
    const nanometres = new Map<string, Float32Array>();
    for (const [name, point] of points) {
      const converted = toNanometres(point);
      if (converted === undefined) {
        throw new Error(`Point ${name} has no position in nanometres`);
      }
      nanometres.set(name, converted);
    }
    const info = await this.ensureTable();
    const rowId = await createAnnotationRow(
      fetchOk,
      baseUrl,
      this.spec.name,
      branchId,
      new Map(
        [...nanometres].map(([name, point]) => [
          name,
          nanometresToTableVoxels(Array.from(point), info.voxelResolution),
        ]),
      ),
      payload,
    );
    tablesSession.rowWritten(this.spec.name, rowId);
    return rowId;
  }

  async remove(branchId: number, rowId: bigint): Promise<void> {
    const { fetchOk, baseUrl, tablesSession } = this.options;
    await deleteAnnotationRows(fetchOk, baseUrl, this.spec.name, branchId, [
      rowId,
    ]);
    tablesSession.rowRemoved(this.spec.name, rowId);
  }

  private ensureTable(): Promise<AnnotationTableInfo> {
    if (this.ensured === undefined) {
      const ensuring = this.findOrCreateTable();
      this.ensured = ensuring;
      ensuring.catch(() => {
        if (this.ensured === ensuring) this.ensured = undefined;
      });
    }
    return this.ensured;
  }

  private async findOrCreateTable(): Promise<AnnotationTableInfo> {
    const found = await this.findTable();
    if (found !== undefined) return found;
    const { fetchOk, baseUrl, nanometresPerUnit } = this.options;
    const voxelResolution = nanometresPerUnit();
    if (voxelResolution === undefined) {
      throw new Error("The graph has no nanometre scale");
    }
    const { name, schema, schemaVersion, description } = this.spec;
    await createAnnotationTable(fetchOk, baseUrl, {
      tableName: name,
      schemaType: schema,
      schemaVersion,
      voxelResolution,
      description,
      readPermission: "PUBLIC",
      writePermission: "PUBLIC",
    });
    const created = await this.findTable();
    if (created === undefined) {
      throw new Error(
        `Annotation table ${name} is missing after it was created`,
      );
    }
    return created;
  }

  private async findTable(): Promise<AnnotationTableInfo | undefined> {
    const { fetchOk, baseUrl } = this.options;
    const tables = await listAnnotationTables(fetchOk, baseUrl);
    return tables.find(({ name }) => name === this.spec.name);
  }
}
