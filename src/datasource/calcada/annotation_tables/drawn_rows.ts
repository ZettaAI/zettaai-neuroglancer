/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { TableRows } from "#src/datasource/calcada/annotation_tables/table_rows.js";
import {
  firstInstanceOfRow,
  instanceId,
  instanceOfId,
  rowCount,
  rowOfInstance,
} from "#src/datasource/calcada/annotation_tables/table_rows.js";

export interface DrawnAnnotation {
  table: string;
  /** The id of its (first) annotation in the table's annotation state. */
  layerId: string;
  id: bigint;
  value: number;
}

/** The rows of the ticked tables as one list, each entry made when read. */
export interface DrawnRows {
  readonly length: number;
  at(index: number): DrawnAnnotation;
  isSameRow(index: number, other: DrawnRows, otherIndex: number): boolean;
  /** The entry of the row an annotation of `table` belongs to. */
  indexOf(table: string, layerId: string): number | undefined;
}

interface DrawnRow {
  rows: TableRows;
  row: number;
}

class TableRowsList implements DrawnRows {
  readonly length: number;
  private readonly starts: number[];

  constructor(private readonly tables: readonly TableRows[]) {
    let start = 0;
    this.starts = tables.map((rows) => {
      const tableStart = start;
      start += rowCount(rows);
      return tableStart;
    });
    this.length = start;
  }

  rowAt(index: number): DrawnRow {
    let table = this.tables.length - 1;
    while (this.starts[table] > index) --table;
    return { rows: this.tables[table], row: index - this.starts[table] };
  }

  at(index: number): DrawnAnnotation {
    const { rows, row } = this.rowAt(index);
    return {
      table: rows.table,
      layerId: instanceId(rows, firstInstanceOfRow(rows, row)),
      id: rows.rowIds[row],
      value: rows.values[row],
    };
  }

  isSameRow(index: number, other: DrawnRows, otherIndex: number): boolean {
    const { rows, row } = this.rowAt(index);
    if (!(other instanceof TableRowsList)) {
      const { table, id } = other.at(otherIndex);
      return rows.table === table && rows.rowIds[row] === id;
    }
    const { rows: otherRows, row: otherRow } = other.rowAt(otherIndex);
    if (rows === otherRows) return row === otherRow;
    return (
      rows.table === otherRows.table &&
      rows.rowIds[row] === otherRows.rowIds[otherRow]
    );
  }

  indexOf(table: string, layerId: string): number | undefined {
    const tableIndex = this.tables.findIndex((rows) => rows.table === table);
    if (tableIndex === -1) return undefined;
    const rows = this.tables[tableIndex];
    const instance = instanceOfId(rows, layerId);
    if (instance === undefined) return undefined;
    return this.starts[tableIndex] + rowOfInstance(rows, instance);
  }
}

export function drawnRowsOf(tables: readonly TableRows[]): DrawnRows {
  return new TableRowsList(tables);
}

export const NO_DRAWN_ROWS: DrawnRows = drawnRowsOf([]);
