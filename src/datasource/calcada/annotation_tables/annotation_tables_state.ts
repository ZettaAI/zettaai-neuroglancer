/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { cloneDeep, isEqual, isPlainObject, uniqBy } from "lodash-es";
import type { AnnotationTableFilter } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { ANNOTATION_FILTER_OPERATORS } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  expectArray,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

export type { AnnotationTableFilter };

interface SelectedTable {
  table: string;
  filter?: AnnotationTableFilter;
}

const TABLE_JSON_KEY = "table";
const FILTER_JSON_KEY = "filter";

function parseFilter(value: unknown): AnnotationTableFilter {
  const filter = verifyObject(value);
  for (const operator of ANNOTATION_FILTER_OPERATORS) {
    verifyOptionalObjectProperty(filter, operator, verifyObject);
  }
  return filter;
}

/** Known operators only, as a frozen copy; no operator at all is no filter. */
function normalizeFilter(
  filter: AnnotationTableFilter | undefined,
): AnnotationTableFilter | undefined {
  if (filter === undefined) return undefined;
  const normalized: AnnotationTableFilter = {};
  for (const operator of ANNOTATION_FILTER_OPERATORS) {
    const fields = filter[operator];
    if (isPlainObject(fields)) {
      normalized[operator] = Object.freeze(cloneDeep(fields));
    }
  }
  return Object.keys(normalized).length === 0
    ? undefined
    : Object.freeze(normalized);
}

function parseSelectedTable(value: unknown): SelectedTable {
  if (typeof value === "string") return { table: value };
  const filter = verifyOptionalObjectProperty(
    value,
    FILTER_JSON_KEY,
    parseFilter,
  );
  return {
    table: verifyObjectProperty(value, TABLE_JSON_KEY, verifyString),
    ...(filter === undefined ? {} : { filter }),
  };
}

export class CalcadaAnnotationTablesState
  extends RefCounted
  implements Trackable
{
  readonly changed = new NullarySignal();
  private selected: readonly SelectedTable[] = [];
  private ticked_: readonly string[] = [];

  /** Selected tables in selection order. */
  get ticked(): readonly string[] {
    return this.ticked_;
  }

  filterOf(table: string): AnnotationTableFilter | undefined {
    return this.selected.find((entry) => entry.table === table)?.filter;
  }

  setFilter(table: string, filter: AnnotationTableFilter | undefined) {
    this.select(
      this.selected.map((entry) =>
        entry.table === table ? { table, filter } : entry,
      ),
    );
  }

  setTicked(names: readonly string[]) {
    this.select(
      names.map((table) => ({ table, filter: this.filterOf(table) })),
    );
  }

  untick(...names: string[]) {
    this.setTicked(this.ticked_.filter((name) => !names.includes(name)));
  }

  reset() {
    this.setTicked([]);
  }

  private select(entries: readonly SelectedTable[]) {
    const unique = uniqBy(entries, ({ table }) => table).map(
      ({ table, filter }) => {
        const normalized = normalizeFilter(filter);
        return normalized === undefined
          ? { table }
          : { table, filter: normalized };
      },
    );
    if (isEqual(unique, this.selected)) return;
    this.selected = unique;
    this.ticked_ = unique.map(({ table }) => table);
    this.changed.dispatch();
  }

  toJSON() {
    return this.selected.length === 0
      ? undefined
      : this.selected.map((entry) => ({ ...entry }));
  }

  /** Also accepts the earlier array of table names. */
  restoreState(value: unknown) {
    if (value === undefined || value === null) {
      this.reset();
      return;
    }
    this.select(expectArray(value).map(parseSelectedTable));
  }
}
