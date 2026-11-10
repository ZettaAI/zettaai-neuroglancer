/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { TraceDecision } from "#src/datasource/calcada/trace_end_check.js";
import type { TraceTableOptions } from "#src/datasource/calcada/trace_written_table.js";
import { TraceWrittenTable } from "#src/datasource/calcada/trace_written_table.js";

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
  /** Absent for a contact marked ambiguous: no sphere was looked in. */
  radiusNm?: number;
  /** Both absent for an end asked for at the seed sphere, before any decision. */
  after?: TraceDecision;
  lineId?: bigint;
  /** In global coordinates. */
  position: Float32Array;
}

/** A contact marked ambiguous ends the trace there, uncertainly. */
export function ambiguousEnd(
  lineId: bigint,
  contact: Float32Array,
  threshold: number,
): TraceEndpointRow {
  return { status: "uncertain", threshold, lineId, position: contact };
}

export class TraceEndpointTable {
  private readonly tables: Record<TraceEndStatus, TraceWrittenTable>;

  constructor(options: TraceTableOptions) {
    const tableFor = (status: TraceEndStatus) =>
      new TraceWrittenTable(options, {
        name: TRACE_ENDPOINTS_TABLES[status],
        schema: TRACE_ENDPOINT_SCHEMA,
        schemaVersion: TRACE_ENDPOINT_SCHEMA_VERSION,
        description: TRACE_ENDPOINTS_DESCRIPTIONS[status],
      });
    this.tables = {
      certain: tableFor("certain"),
      uncertain: tableFor("uncertain"),
    };
  }

  write(branchId: number, row: TraceEndpointRow): Promise<bigint> {
    return this.tables[row.status].write(
      branchId,
      new Map([[TRACE_ENDPOINT_POINT, row.position]]),
      {
        status: row.status,
        threshold: row.threshold,
        ...(row.radiusNm !== undefined && { radius_nm: row.radiusNm }),
        ...(row.after !== undefined && { after: row.after }),
        ...(row.lineId !== undefined && { line_id: String(row.lineId) }),
      },
    );
  }

  remove(
    branchId: number,
    status: TraceEndStatus,
    rowId: bigint,
  ): Promise<void> {
    return this.tables[status].remove(branchId, rowId);
  }
}
