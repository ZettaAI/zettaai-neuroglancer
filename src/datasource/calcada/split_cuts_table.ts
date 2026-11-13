/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { errorMessage } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import type { TraceTableOptions } from "#src/datasource/calcada/trace_written_table.js";
import { TraceWrittenTable } from "#src/datasource/calcada/trace_written_table.js";

export const SPLIT_CUTS_TABLE = "split_cuts";
export const SPLIT_CUT_SCHEMA = "split_cut";
const SPLIT_CUT_SCHEMA_VERSION = 1;
const SPLIT_CUTS_DESCRIPTION = "A line across each edge a split cut";
const AXES = 3;
const LINE_ENDS = 2;

/** In nanometres. */
export type CutLineNm = [number[], number[]];

export interface SplitCutRow {
  operationId: number;
  /** Both in global coordinates, one in each piece the cut separated. */
  pointA: Float32Array;
  pointB: Float32Array;
}

const isPointNm = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length === AXES &&
  value.every((axis) => typeof axis === "number");

function parseCutLineNm(value: unknown): CutLineNm | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== LINE_ENDS ||
    !value.every(isPointNm)
  ) {
    return undefined;
  }
  return [value[0], value[1]];
}

/** A split response's `cut_lines_nm`, its malformed lines left out. */
export function parseCutLinesNm(value: unknown): CutLineNm[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseCutLineNm)
    .filter((line): line is CutLineNm => line !== undefined);
}

/** A line per edge a split cut. */
export class SplitCutsTable {
  private readonly table: TraceWrittenTable;

  constructor(options: TraceTableOptions) {
    this.table = new TraceWrittenTable(options, {
      name: SPLIT_CUTS_TABLE,
      schema: SPLIT_CUT_SCHEMA,
      schemaVersion: SPLIT_CUT_SCHEMA_VERSION,
      description: SPLIT_CUTS_DESCRIPTION,
    });
  }

  write(branchId: number, row: SplitCutRow): Promise<bigint> {
    return this.table.write(
      branchId,
      new Map([
        ["pt_a", row.pointA],
        ["pt_b", row.pointB],
      ]),
      { operation_id: row.operationId },
    );
  }

  remove(branchId: number, rowId: bigint): Promise<void> {
    return this.table.remove(branchId, rowId);
  }
}

interface SplitCutRowRef {
  branchId: number;
  rowId: Promise<bigint | undefined>;
}

/** The rows of the splits still on the undo stack, by operation. */
export class SplitCutRows {
  private readonly rows = new Map<number, SplitCutRowRef[]>();

  constructor(
    private readonly table: Pick<SplitCutsTable, "write" | "remove">,
    private readonly reportError: (message: string) => void,
  ) {}

  record(branchId: number, row: SplitCutRow): void {
    const rowId = this.table.write(branchId, row).catch((error) => {
      this.reportError(
        `Could not record the split cut: ${errorMessage(error)}`,
      );
      return undefined;
    });
    const recorded = this.rows.get(row.operationId) ?? [];
    recorded.push({ branchId, rowId });
    this.rows.set(row.operationId, recorded);
  }

  /** The split was undone: its rows go in the background. */
  reverted(operationId: number): void {
    const recorded = this.rows.get(operationId);
    if (recorded === undefined) return;
    this.rows.delete(operationId);
    for (const row of recorded) {
      void row.rowId
        .then(async (rowId) => {
          if (rowId !== undefined) await this.table.remove(row.branchId, rowId);
        })
        .catch((error) => {
          this.reportError(
            `Could not remove the split cut: ${errorMessage(error)}`,
          );
        });
    }
  }

  /** The split can no longer be undone: its rows stay. */
  forget(operationId: number): void {
    this.rows.delete(operationId);
  }
}
