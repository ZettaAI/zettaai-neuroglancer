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

export const ACCEPTED_CANDIDATES_TABLE = "accepted_candidates";
export const ACCEPTED_CANDIDATE_SCHEMA = "accepted_candidate";
const ACCEPTED_CANDIDATE_SCHEMA_VERSION = 1;
const ACCEPTED_CANDIDATES_DESCRIPTION = "Candidates accepted while tracing";

export interface AcceptedCandidateRow {
  score: number;
  lineId: bigint;
  depth: number;
  /** The merge's edit operation, when the server reported one. */
  operationId: number | undefined;
  pieceA: bigint;
  pieceB: bigint;
  /** In global coordinates. */
  pointA: Float32Array;
  pointB: Float32Array;
}

/** A line per accept, from the seed's side of the contact to the partner's. */
export class AcceptedCandidatesTable {
  private readonly table: TraceWrittenTable;

  constructor(options: TraceTableOptions) {
    this.table = new TraceWrittenTable(options, {
      name: ACCEPTED_CANDIDATES_TABLE,
      schema: ACCEPTED_CANDIDATE_SCHEMA,
      schemaVersion: ACCEPTED_CANDIDATE_SCHEMA_VERSION,
      description: ACCEPTED_CANDIDATES_DESCRIPTION,
    });
  }

  write(branchId: number, row: AcceptedCandidateRow): Promise<bigint> {
    return this.table.write(
      branchId,
      new Map([
        ["pt_a", row.pointA],
        ["pt_b", row.pointB],
      ]),
      {
        score: row.score,
        line_id: String(row.lineId),
        depth: row.depth,
        ...(row.operationId !== undefined && {
          operation_id: row.operationId,
        }),
        piece_a: String(row.pieceA),
        piece_b: String(row.pieceB),
      },
    );
  }

  remove(branchId: number, rowId: bigint): Promise<void> {
    return this.table.remove(branchId, rowId);
  }
}

interface AcceptedLine {
  lineId: bigint;
  branchId: number;
  rowId: Promise<bigint | undefined>;
}

/** The trace's accepts, newest last, each with the row it wrote. */
export class AcceptedLines {
  private entries: AcceptedLine[] = [];

  constructor(
    private readonly table: Pick<AcceptedCandidatesTable, "write" | "remove">,
    private readonly reportError: (message: string) => void,
  ) {}

  record(branchId: number, row: AcceptedCandidateRow): void {
    const rowId = this.table.write(branchId, row).catch((error) => {
      this.reportError(
        `Could not record the accepted candidate: ${errorMessage(error)}`,
      );
      return undefined;
    });
    this.entries.push({ lineId: row.lineId, branchId, rowId });
  }

  /** The newest accept's line; its row is removed in the background. */
  forgetNewest(): bigint | undefined {
    const newest = this.entries.pop();
    if (newest === undefined) return undefined;
    void newest.rowId
      .then(async (rowId) => {
        if (rowId !== undefined) {
          await this.table.remove(newest.branchId, rowId);
        }
      })
      .catch((error) => {
        this.reportError(
          `Could not remove the accepted candidate: ${errorMessage(error)}`,
        );
      });
    return newest.lineId;
  }

  clear(): void {
    this.entries = [];
  }
}
