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

export const SPLIT_EDITS_TABLE = "split_edits";
export const SPLIT_EDIT_SCHEMA = "split_edit";
const SPLIT_EDIT_SCHEMA_VERSION = 1;
const SPLIT_EDITS_DESCRIPTION = "Where each split cut the segment";
const SPLIT_EDIT_POINT = "pt";
const AXES = 3;

export interface SplitEditRow {
  operationId: number;
  /** In global coordinates. */
  position: Float32Array;
}

/** A split response's `cut_point_nm`; undefined when absent or malformed. */
export function parseCutPointNm(value: unknown): number[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== AXES ||
    !value.every((axis) => typeof axis === "number")
  ) {
    return undefined;
  }
  return value;
}

/** A point per split, where its cut is widest. */
export class SplitEditsTable {
  private readonly table: TraceWrittenTable;

  constructor(options: TraceTableOptions) {
    this.table = new TraceWrittenTable(options, {
      name: SPLIT_EDITS_TABLE,
      schema: SPLIT_EDIT_SCHEMA,
      schemaVersion: SPLIT_EDIT_SCHEMA_VERSION,
      description: SPLIT_EDITS_DESCRIPTION,
    });
  }

  write(branchId: number, row: SplitEditRow): Promise<bigint> {
    return this.table.write(
      branchId,
      new Map([[SPLIT_EDIT_POINT, row.position]]),
      { operation_id: row.operationId },
    );
  }

  remove(branchId: number, rowId: bigint): Promise<void> {
    return this.table.remove(branchId, rowId);
  }
}

interface SplitEditRowRef {
  branchId: number;
  rowId: Promise<bigint | undefined>;
}

/** The rows of the splits still on the undo stack, by operation. */
export class SplitEditRows {
  private readonly rows = new Map<number, SplitEditRowRef>();

  constructor(
    private readonly table: Pick<SplitEditsTable, "write" | "remove">,
    private readonly reportError: (message: string) => void,
  ) {}

  record(operationId: number, branchId: number, position: Float32Array): void {
    const rowId = this.table
      .write(branchId, { operationId, position })
      .catch((error) => {
        this.reportError(
          `Could not record the split edit: ${errorMessage(error)}`,
        );
        return undefined;
      });
    this.rows.set(operationId, { branchId, rowId });
  }

  /** The split was undone: its row goes in the background. */
  reverted(operationId: number): void {
    const row = this.rows.get(operationId);
    if (row === undefined) return;
    this.rows.delete(operationId);
    void row.rowId
      .then(async (rowId) => {
        if (rowId !== undefined) await this.table.remove(row.branchId, rowId);
      })
      .catch((error) => {
        this.reportError(
          `Could not remove the split edit: ${errorMessage(error)}`,
        );
      });
  }

  /** The split can no longer be undone: its row stays. */
  forget(operationId: number): void {
    this.rows.delete(operationId);
  }
}
