/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { chunk, debounce, isEqual } from "lodash-es";
import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type {
  Annotation,
  AnnotationPropertySpec,
} from "#src/annotation/index.js";
import type {
  FetchedTablePoints,
  LayerRow,
} from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import {
  COORDINATES_PER_POSITION,
  annotationRowId,
  colorForTable,
  toLayerAnnotations,
} from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import type {
  AnnotationReadCoordinates,
  AnnotationTableInfo,
  AnnotationTableQuery,
  SchemaCache,
  SegmentAnnotation,
  TablePoints,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import {
  AnnotationTableForbidden,
  AnnotationTableMissing,
  MAX_TABLES_PER_SEGMENT_REQUEST,
  deleteAnnotationRows,
  fetchAnnotationRows,
  fetchSegmentCounts,
  fetchSegmentPoints,
  fetchTableCount,
  fetchTablePoints,
  listAnnotationTables,
  retryOnceIfUnauthorized,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { CalcadaAnnotationTablesState } from "#src/datasource/calcada/annotation_tables/annotation_tables_state.js";
import type {
  CalcadaTableAnnotationSource,
  TableAnnotationSourceOptions,
} from "#src/datasource/calcada/annotation_tables/table_annotation_source.js";
import type { HttpSource } from "#src/datasource/calcada/base.js";
import { hasExplicitTimestamp } from "#src/datasource/calcada/graph_coordinates.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type {
  AnnotationListColumnWidths,
  SelectedListAnnotation,
} from "#src/ui/annotations.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import type { ReadonlySignal } from "#src/util/signal.js";
import { Signal } from "#src/util/signal.js";

export const MAX_ANNOTATION_ROOTS = 50;
/** Rows summed over every selected table and every scope it is read in. */
export const MAX_DRAWN_ANNOTATIONS = 1_000_000;
export const MAX_ANNOTATION_REQUESTS_IN_FLIGHT = 4;
export const ANNOTATION_TABLE_SUBSUBSOURCE_PREFIX = "calcadaAnnotationTable:";

export const VISIBLE_SEGMENTS_DEBOUNCE_MS = 150;
export const TABLE_ABSENT_AT_TIMESTAMP_NOTE = "Not present at this time";
export const TABLE_UNLISTED_NOTE = "Not in the current table list";

const VALUE_PROPERTY: AnnotationPropertySpec = {
  type: "float32",
  identifier: "value",
  description: undefined,
  default: 0,
};

const THOUSANDS_GROUP = /\B(?=(\d{3})+$)/g;

const EMPTY_TABLE_POINTS: TablePoints = Object.freeze({
  ids: [],
  values: new Float64Array(),
  roots: [],
  points: [],
});

export type AnnotationFetchPhase = "count" | "points";

/** What one cache entry is read for: a root's segment tables, or one whole table. */
export interface AnnotationScope {
  key: string;
  /** Absent for a whole-table read. */
  root: bigint | undefined;
  tables: readonly string[];
}

export interface AnnotationFetchRequest {
  key: string;
  root: bigint | undefined;
  tables: string[];
  phase: AnnotationFetchPhase;
}

export interface AnnotationScopeEntry {
  counts: Map<string, number>;
  points: Map<string, TablePoints>;
}

export interface AnnotationTotals {
  /** Every count is known or has failed. */
  complete: boolean;
  total: number;
  byTable: Map<string, number>;
}

export interface AnnotationTableStatus {
  table: string;
  annotations: number;
  fetchedRoots: number;
  error?: string;
  note?: string;
}

export interface DrawnAnnotation {
  table: string;
  /** The id of its (first) annotation in the table's annotation state. */
  layerId: string;
  id: bigint;
  value: number;
}

export interface AnnotationFetchFailure {
  untick: string[];
  absent: string[];
  failed: string[];
  message: string;
}

export interface TableAnnotationState {
  layerState: AnnotationLayerState;
  source: CalcadaTableAnnotationSource;
}

interface SelectedDetails {
  table: string;
  layerId: string;
  description: string;
}

export function formatCount(count: number): string {
  return String(count).replace(THOUSANDS_GROUP, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function annotationCacheKey(
  { branchId, timestamp }: AnnotationReadCoordinates,
  root: bigint,
): string {
  return `${branchId}|${timestamp}|${root}`;
}

export function wholeTableCacheKey(
  { branchId, timestamp }: AnnotationReadCoordinates,
  table: string,
): string {
  return `${branchId}|${timestamp}|table:${table}`;
}

function compareIds(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The roots to show, capped: those already held (cached or asked for) first,
 * then the others by id, so the shown subset does not reshuffle.
 */
export function visibleAnnotationRoots(
  visible: Iterable<bigint>,
  isHeld: (root: bigint) => boolean,
): bigint[] {
  const sorted = [...new Set(visible)].sort(compareIds);
  return [
    ...sorted.filter(isHeld),
    ...sorted.filter((root) => !isHeld(root)),
  ].slice(0, MAX_ANNOTATION_ROOTS);
}

/**
 * Per table, the message of each scope whose fetch failed: one scope's later
 * success must not hide another scope's failure.
 */
export class RootFailures {
  private readonly byTable = new Map<string, Map<string, string>>();

  record(table: string, key: string, message: string) {
    const failures = this.byTable.get(table) ?? new Map<string, string>();
    failures.set(key, message);
    this.byTable.set(table, failures);
  }

  has(table: string, key: string): boolean {
    return this.byTable.get(table)?.has(key) ?? false;
  }

  clear(table: string, key: string) {
    this.byTable.get(table)?.delete(key);
  }

  dropRoot(key: string) {
    for (const failures of this.byTable.values()) failures.delete(key);
  }

  dropTable(table: string) {
    this.byTable.delete(table);
  }

  reset() {
    this.byTable.clear();
  }

  messageFor(table: string): string | undefined {
    return this.byTable.get(table)?.values().next().value;
  }
}

export function visibleRootsNote(visibleCount: number): string | undefined {
  return visibleCount > MAX_ANNOTATION_ROOTS
    ? `Showing annotations for ${MAX_ANNOTATION_ROOTS} of ${visibleCount} visible segments.`
    : undefined;
}

export function annotationScopes(input: {
  visibleRoots: Iterable<bigint>;
  segmentTables: readonly string[];
  wholeTables: readonly string[];
  coords: AnnotationReadCoordinates;
  isHeld: (key: string) => boolean;
}): AnnotationScope[] {
  const { segmentTables, wholeTables, coords, isHeld } = input;
  const roots = visibleAnnotationRoots(input.visibleRoots, (root) =>
    isHeld(annotationCacheKey(coords, root)),
  );
  return [
    ...roots.map((root) => ({
      key: annotationCacheKey(coords, root),
      root,
      tables: segmentTables,
    })),
    ...wholeTables.map((table) => ({
      key: wholeTableCacheKey(coords, table),
      root: undefined,
      tables: [table],
    })),
  ];
}

export function prunedAnnotationKeys(
  scopes: readonly AnnotationScope[],
  cache: ReadonlyMap<string, AnnotationScopeEntry>,
  pending: ReadonlyMap<string, ReadonlyMap<string, number>>,
): string[] {
  const wanted = new Set(scopes.map(({ key }) => key));
  return [...new Set([...cache.keys(), ...pending.keys()])].filter(
    (key) => !wanted.has(key),
  );
}

/** Counts summed per table in `tables` order; a failed count adds nothing. */
export function annotationTotals(
  scopes: readonly AnnotationScope[],
  tables: readonly string[],
  cache: ReadonlyMap<string, AnnotationScopeEntry>,
  hasFailed: (table: string, key: string) => boolean,
): AnnotationTotals {
  let complete = true;
  let total = 0;
  const byTable = new Map<string, number>();
  for (const table of tables) {
    let tableTotal = 0;
    for (const { key, tables: scopeTables } of scopes) {
      if (!scopeTables.includes(table)) continue;
      const count = cache.get(key)?.counts.get(table);
      if (count === undefined) {
        if (!hasFailed(table, key)) complete = false;
        continue;
      }
      tableTotal += count;
    }
    byTable.set(table, tableTotal);
    total += tableTotal;
  }
  return { complete, total, byTable };
}

export function annotationLimitNote({
  total,
  byTable,
}: AnnotationTotals): string | undefined {
  if (total <= MAX_DRAWN_ANNOTATIONS) return undefined;
  const tables = [...byTable]
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${table}: ${formatCount(count)}`)
    .join(", ");
  return `More than ${formatCount(MAX_DRAWN_ANNOTATIONS)} annotations in the selected tables (${tables}). Add a filter or deselect a table.`;
}

/** Counts first; points only once `pointsAllowed`, for what is counted. */
export function planAnnotationFetches(input: {
  scopes: readonly AnnotationScope[];
  cache: ReadonlyMap<string, AnnotationScopeEntry>;
  pending: ReadonlyMap<string, ReadonlyMap<string, number>>;
  freeSlots: number;
  pointsAllowed: boolean;
}): AnnotationFetchRequest[] {
  const { scopes, cache, pending, freeSlots, pointsAllowed } = input;
  const requests: AnnotationFetchRequest[] = [];
  const plan = (
    phase: AnnotationFetchPhase,
    lacks: (entry: AnnotationScopeEntry | undefined, table: string) => boolean,
  ) => {
    for (const { key, root, tables } of scopes) {
      const entry = cache.get(key);
      const wanted = tables.filter(
        (table) => lacks(entry, table) && !pending.get(key)?.has(table),
      );
      for (const group of chunk(wanted, MAX_TABLES_PER_SEGMENT_REQUEST)) {
        if (requests.length >= freeSlots) return;
        requests.push({ key, root, tables: group, phase });
      }
    }
  };
  plan("count", (entry, table) => !entry?.counts.has(table));
  if (pointsAllowed) {
    plan(
      "points",
      (entry, table) =>
        entry !== undefined &&
        entry.counts.has(table) &&
        !entry.points.has(table),
    );
  }
  return requests;
}

function scopeEntry(
  cache: Map<string, AnnotationScopeEntry>,
  key: string,
): AnnotationScopeEntry {
  let entry = cache.get(key);
  if (entry === undefined) {
    entry = { counts: new Map(), points: new Map() };
    cache.set(key, entry);
  }
  return entry;
}

/** A table the server left out counts zero; a zero count needs no points. */
export function acceptAnnotationCounts(
  cache: Map<string, AnnotationScopeEntry>,
  { key, tables }: { key: string; tables: readonly string[] },
  counts: ReadonlyMap<string, number>,
) {
  const entry = scopeEntry(cache, key);
  for (const table of tables) {
    const count = counts.get(table) ?? 0;
    entry.counts.set(table, count);
    if (count === 0) entry.points.set(table, EMPTY_TABLE_POINTS);
  }
}

/** The rows received replace the count, so the limit is checked against them. */
export function acceptAnnotationPoints(
  cache: Map<string, AnnotationScopeEntry>,
  { key, tables }: { key: string; tables: readonly string[] },
  points: ReadonlyMap<string, TablePoints>,
) {
  const entry = scopeEntry(cache, key);
  for (const table of tables) {
    const received = points.get(table) ?? EMPTY_TABLE_POINTS;
    entry.points.set(table, received);
    entry.counts.set(table, received.ids.length);
  }
}

export function withoutAnnotationRow(
  points: TablePoints,
  rowId: bigint,
): TablePoints | undefined {
  const index = points.ids.indexOf(rowId);
  if (index === -1) return undefined;
  const isKept = (_: unknown, rowIndex: number) => rowIndex !== index;
  return {
    ids: points.ids.filter(isKept),
    values: points.values.filter(isKept),
    roots: points.roots,
    points: points.points.map(({ name, positions, rootIndex }) => ({
      name,
      positions: positions.filter(
        (_, offset) => Math.floor(offset / COORDINATES_PER_POSITION) !== index,
      ),
      rootIndex: rootIndex.filter(isKept),
    })),
  };
}

/** Drops a deleted row from every scope of its table. */
export function removeAnnotationRow(
  cache: ReadonlyMap<string, AnnotationScopeEntry>,
  table: string,
  rowId: bigint,
) {
  for (const entry of cache.values()) {
    const points = entry.points.get(table);
    const remaining =
      points === undefined ? undefined : withoutAnnotationRow(points, rowId);
    if (remaining === undefined) continue;
    entry.points.set(table, remaining);
    entry.counts.set(table, remaining.ids.length);
  }
}

/**
 * Tables are listed as they are now, but read at the explicit timestamp: one
 * missing there may simply not exist yet, which is no reason to untick it.
 */
export function classifyAnnotationError(
  error: unknown,
  requested: readonly string[],
  explicitTimestamp: boolean,
): AnnotationFetchFailure {
  const message = errorMessage(error);
  if (
    error instanceof AnnotationTableForbidden ||
    error instanceof AnnotationTableMissing
  ) {
    const named = error.table
      .split(",")
      .filter((table) => requested.includes(table));
    const tables = named.length > 0 ? named : [...requested];
    if (error instanceof AnnotationTableMissing && explicitTimestamp) {
      return { untick: [], absent: tables, failed: [], message };
    }
    return { untick: tables, absent: [], failed: tables, message };
  }
  return { untick: [], absent: [], failed: [...requested], message };
}

/** Every scope of the table has its points or has failed. */
export function tablePointsSettled(
  table: string,
  scopes: readonly AnnotationScope[],
  cache: ReadonlyMap<string, AnnotationScopeEntry>,
  hasFailed: (table: string, key: string) => boolean,
): boolean {
  return scopes.every(
    ({ key, tables }) =>
      !tables.includes(table) ||
      cache.get(key)?.points.has(table) === true ||
      hasFailed(table, key),
  );
}

/** The scopes' fetched points of one table, as the renderer takes them. */
export function fetchedTablePoints(
  table: string,
  scopes: readonly AnnotationScope[],
  cache: ReadonlyMap<string, AnnotationScopeEntry>,
): FetchedTablePoints[] {
  return scopes.flatMap(({ key, root, tables }) => {
    const points = tables.includes(table)
      ? cache.get(key)?.points.get(table)
      : undefined;
    return points === undefined ? [] : [{ fetchedUnder: root, points }];
  });
}

export function annotationTableStatus(input: {
  table: string;
  fetched: readonly FetchedTablePoints[];
  annotations: number;
  error?: string;
  note?: string;
}): AnnotationTableStatus {
  const { table, fetched, annotations, error, note } = input;
  return {
    table,
    annotations,
    fetchedRoots: fetched.filter(
      ({ fetchedUnder }) => fetchedUnder !== undefined,
    ).length,
    ...(error === undefined ? {} : { error }),
    ...(note === undefined ? {} : { note }),
  };
}

/** The row's payload, one `<field>: <value>` line each, then its id. */
export function describeAnnotationRow({
  id,
  payload,
}: SegmentAnnotation): string {
  return [
    ...Object.entries(payload).map(
      ([field, value]) =>
        `${field}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    ),
    `id: ${id}`,
  ].join("\n");
}

/**
 * Palette slots by tick order: a table keeps its slot while it stays ticked,
 * and a newly ticked one takes the lowest slot nobody holds.
 */
export function assignColorSlots(
  previous: ReadonlyMap<string, number>,
  ticked: readonly string[],
): Map<string, number> {
  const slots = new Map<string, number>();
  for (const table of ticked) {
    const slot = previous.get(table);
    if (slot !== undefined) slots.set(table, slot);
  }
  const taken = new Set(slots.values());
  let next = 0;
  for (const table of ticked) {
    if (slots.has(table)) continue;
    while (taken.has(next)) next++;
    slots.set(table, next);
    taken.add(next);
    next++;
  }
  return slots;
}

async function readScope<T>(
  root: bigint | undefined,
  queries: AnnotationTableQuery[],
  readSegment: (
    root: bigint,
    queries: AnnotationTableQuery[],
  ) => Promise<Map<string, T>>,
  readTable: (query: AnnotationTableQuery) => Promise<T>,
): Promise<Map<string, T>> {
  if (root !== undefined) return readSegment(root, queries);
  return new Map(
    await Promise.all(
      queries.map(
        async (query) => [query.table.name, await readTable(query)] as const,
      ),
    ),
  );
}

export interface AnnotationTablesConnection {
  readonly httpSource: HttpSource;
  readonly branchId: WatchableValueInterface<number>;
  readonly timestamp: WatchableValueInterface<number | undefined>;
  readonly visibleSegments: Uint64Set;
  readonly graphEdited: ReadonlySignal<
    (oldRoots: Iterable<bigint>, newRoots: Iterable<bigint>) => void
  >;
  nanometresToSource(
    nanometres: [number, number, number],
  ): Float32Array | undefined;
  makeAnnotationState(
    subsubsourceId: string,
    color: vec3,
    properties: AnnotationPropertySpec[],
    options: TableAnnotationSourceOptions,
  ): TableAnnotationState;
  selectAnnotation(state: AnnotationLayerState, annotation: Annotation): void;
  moveToAnnotation(state: AnnotationLayerState, annotation: Annotation): void;
  /** NG's list entry for the annotation, and its column widths. */
  makeListElement(
    state: AnnotationLayerState,
    annotation: Annotation,
  ): [HTMLElement, number[]];
  /** NG's list header row for the state's entries. */
  renderListHeader(
    state: AnnotationLayerState,
    header: HTMLElement,
    columnWidths: AnnotationListColumnWidths,
  ): void;
  readonly selectedAnnotation: WatchableValueInterface<
    SelectedListAnnotation | undefined
  >;
  /** List entries show positions in these coordinates. */
  readonly listCoordinatesChanged: ReadonlySignal<() => void>;
  clearHover(): void;
  /** Runs the callback before the next frame is drawn. */
  scheduleFrame(callback: () => void): void;
}

export class CalcadaAnnotationTablesSession extends RefCounted {
  readonly tables = new WatchableValue<AnnotationTableInfo[] | undefined>(
    undefined,
  );
  readonly status = new WatchableValue<AnnotationTableStatus[]>([]);
  readonly drawn = new WatchableValue<DrawnAnnotation[]>([]);
  readonly listError = new WatchableValue<string | undefined>(undefined);
  readonly rootsNote = new WatchableValue<string | undefined>(undefined);
  /** Set while the selected tables hold more than MAX_DRAWN_ANNOTATIONS. */
  readonly limitNote = new WatchableValue<string | undefined>(undefined);
  /** The counts of the tables in view, whether drawn or not. */
  readonly totals = new WatchableValue<AnnotationTotals>({
    complete: true,
    total: 0,
    byTable: new Map(),
  });
  /** A drawn annotation's list entry changed in place. */
  readonly annotationUpdated = new Signal<
    (table: string, layerId: string) => void
  >();
  private readonly schemas: SchemaCache = new Map();
  private readonly cache = new Map<string, AnnotationScopeEntry>();
  // Per cache key, the request each table was last asked in: in flight, or
  // failed and not to be retried until something changes. An answer counts
  // only for the tables still marked with its request.
  private readonly pending = new Map<string, Map<string, number>>();
  private readonly layerStates = new Map<string, TableAnnotationState>();
  private readonly rendered = new Map<string, number>();
  private readonly drawnByTable = new Map<string, DrawnAnnotation[]>();
  // Redrawn together once per frame: a burst of answers rebuilds each table
  // once, not once per answer.
  private readonly stale = new Set<string>();
  private frameRequested = false;
  private readonly errors = new Map<string, string>();
  private readonly rootFailures = new RootFailures();
  // Tables the server does not have at the explicit timestamp in view.
  private readonly absent = new Set<string>();
  private colorSlots = new Map<string, number>();
  private shownTables: readonly string[] = [];
  private shownQueries = new Map<string, unknown>();
  private details: SelectedDetails | undefined;
  private lastSelect = 0;
  private lastRequest = 0;
  private tablesToken = 0;
  private running = 0;
  private coords: AnnotationReadCoordinates;
  private readonly refetch = this.registerCancellable(
    debounce(() => this.fetchVisible(), VISIBLE_SEGMENTS_DEBOUNCE_MS),
  );

  constructor(
    private readonly connection: AnnotationTablesConnection,
    private readonly state: CalcadaAnnotationTablesState,
  ) {
    super();
    this.coords = this.currentCoordinates();
    this.registerDisposer(
      connection.visibleSegments.changed.add(() => this.refetch()),
    );
    this.registerDisposer(
      connection.branchId.changed.add(() => this.coordinatesChanged()),
    );
    this.registerDisposer(
      connection.timestamp.changed.add(() => this.coordinatesChanged()),
    );
    this.registerDisposer(
      connection.graphEdited.add((oldRoots, newRoots) =>
        this.rootsEdited([...oldRoots, ...newRoots]),
      ),
    );
    this.registerDisposer(state.changed.add(() => this.selectionChanged()));
    this.selectionChanged();
    this.refreshTables();
  }

  refreshTables() {
    const token = ++this.tablesToken;
    const { fetchOkImpl, baseUrl } = this.connection.httpSource;
    retryOnceIfUnauthorized(() =>
      listAnnotationTables(fetchOkImpl, baseUrl, this.schemas),
    ).then(
      (tables) => {
        if (token !== this.tablesToken || this.wasDisposed) return;
        this.listError.value = undefined;
        this.tables.value = tables;
        this.untickUnlisted();
        this.invalidate(this.state.ticked);
        this.fetchVisible();
      },
      (error: unknown) => {
        if (token !== this.tablesToken || this.wasDisposed) return;
        this.listError.value = `Could not list annotation tables: ${errorMessage(
          error,
        )}`;
      },
    );
  }

  /** Selects it and reads the row's payload into the annotation's description. */
  select(item: DrawnAnnotation) {
    const found = this.findDrawn(item);
    if (found === undefined) return;
    this.connection.selectAnnotation(found.layerState, found.annotation);
    void this.readDetails(item);
  }

  moveTo(item: DrawnAnnotation) {
    const found = this.findDrawn(item);
    if (found === undefined) return;
    this.select(item);
    this.connection.moveToAnnotation(found.layerState, found.annotation);
  }

  /** NG's own annotation list entry for it, and its column widths. */
  makeListElement(item: DrawnAnnotation): [HTMLElement, number[]] | undefined {
    const found = this.findDrawn(item);
    if (found === undefined) return undefined;
    return this.connection.makeListElement(found.layerState, found.annotation);
  }

  /** NG's list header for the item's entry; false once its table is unticked. */
  renderListHeader(
    item: DrawnAnnotation,
    header: HTMLElement,
    columnWidths: AnnotationListColumnWidths,
  ): boolean {
    const found = this.findDrawn(item);
    if (found === undefined) return false;
    this.connection.renderListHeader(found.layerState, header, columnWidths);
    return true;
  }

  isSelected({ table, layerId }: DrawnAnnotation): boolean {
    const selected = this.connection.selectedAnnotation.value;
    return (
      selected?.annotationId === layerId &&
      selected.annotationLayerState === this.layerStates.get(table)?.layerState
    );
  }

  get annotationSelectionChanged(): ReadonlySignal<() => void> {
    return this.connection.selectedAnnotation.changed;
  }

  get listCoordinatesChanged(): ReadonlySignal<() => void> {
    return this.connection.listCoordinatesChanged;
  }

  clearHover() {
    this.connection.clearHover();
  }

  tableColor(name: string): vec3 {
    return colorForTable(this.colorSlots.get(name) ?? 0);
  }

  private findDrawn({ table, layerId }: DrawnAnnotation) {
    if (!this.state.ticked.includes(table)) return undefined;
    const tableState = this.layerStates.get(table);
    const annotation = tableState?.source.get(layerId);
    if (tableState === undefined || annotation === undefined) return undefined;
    return { layerState: tableState.layerState, annotation };
  }

  private async readDetails({ table, layerId, id }: DrawnAnnotation) {
    const info = this.tableInfo(table);
    if (info === undefined) return;
    const selectId = ++this.lastSelect;
    const coords = this.coords;
    const { fetchOkImpl, baseUrl } = this.connection.httpSource;
    let rows: SegmentAnnotation[];
    try {
      rows = await fetchAnnotationRows(
        fetchOkImpl,
        baseUrl,
        info,
        [id],
        coords,
        this.schemas,
      );
    } catch {
      return;
    }
    const stale =
      this.wasDisposed ||
      selectId !== this.lastSelect ||
      coords !== this.coords;
    if (stale || rows.length === 0) return;
    this.details = {
      table,
      layerId,
      description: describeAnnotationRow(rows[0]),
    };
    this.showDetails(table);
  }

  /** A redraw replaces the annotation objects; the selected one keeps its description. */
  private showDetails(name: string) {
    const { details } = this;
    if (details?.table !== name) return;
    this.layerStates
      .get(name)
      ?.source.setDescription(details.layerId, details.description);
    this.annotationUpdated.dispatch(name, details.layerId);
  }

  private isReadonly(name: string): boolean {
    return (
      !(this.tableInfo(name)?.canWrite ?? false) ||
      hasExplicitTimestamp(this.coords)
    );
  }

  /**
   * Server first; then the row leaves every cached scope of the table. Answers
   * for the table still on their way may hold it, so they are retired and
   * asked again.
   */
  private async deleteRow(name: string, annotation: Annotation) {
    const { fetchOkImpl, baseUrl } = this.connection.httpSource;
    const rowId = annotationRowId(name, annotation.id);
    try {
      await deleteAnnotationRows(fetchOkImpl, baseUrl, name, [rowId]);
    } catch (error) {
      this.errors.set(name, errorMessage(error));
      this.publishStatus();
      throw error;
    }
    if (this.wasDisposed) return;
    this.errors.delete(name);
    removeAnnotationRow(this.cache, name, rowId);
    this.retireInFlight(name);
    this.invalidate([name]);
    this.fetchVisible();
  }

  /** A failed request keeps its mark: it is not retried until something changes. */
  private retireInFlight(name: string) {
    for (const [key, asked] of this.pending) {
      if (!this.rootFailures.has(name, key)) asked.delete(name);
    }
  }

  /** Only live: a table deleted since may still be there at the timestamp. */
  private untickUnlisted() {
    const tables = this.tables.value;
    if (tables === undefined || hasExplicitTimestamp(this.coords)) return;
    const listed = new Set(tables.map((table) => table.name));
    const unlisted = this.state.ticked.filter((name) => !listed.has(name));
    for (const name of unlisted) {
      this.errors.set(name, `Annotation table ${name} not found`);
    }
    if (unlisted.length > 0) this.state.untick(...unlisted);
  }

  private currentCoordinates(): AnnotationReadCoordinates {
    return {
      branchId: this.connection.branchId.value,
      timestamp: this.connection.timestamp.value ?? 0,
    };
  }

  private coordinatesChanged() {
    const coords = this.currentCoordinates();
    if (
      coords.branchId === this.coords.branchId &&
      coords.timestamp === this.coords.timestamp
    ) {
      return;
    }
    this.coords = coords;
    this.cache.clear();
    this.pending.clear();
    this.rootFailures.reset();
    this.absent.clear();
    this.details = undefined;
    for (const table of this.state.ticked) this.errors.delete(table);
    this.invalidate(this.state.ticked);
    this.fetchVisible();
    this.untickUnlisted();
  }

  /**
   * An edit retires and creates roots; only those entries are stale. The new
   * roots join the visible set after the edit is announced, hence the
   * debounced refetch.
   */
  private rootsEdited(roots: readonly bigint[]) {
    for (const root of roots) {
      this.forgetRoot(annotationCacheKey(this.coords, root));
    }
    this.invalidate(this.state.ticked);
    this.refetch();
  }

  private forgetRoot(key: string) {
    this.cache.delete(key);
    this.pending.delete(key);
    this.rootFailures.dropRoot(key);
  }

  /** Back to nothing fetched for the table, in any scope: no request, no failure. */
  private forgetTable(name: string) {
    for (const entry of this.cache.values()) {
      entry.counts.delete(name);
      entry.points.delete(name);
    }
    for (const asked of this.pending.values()) asked.delete(name);
    this.rootFailures.dropTable(name);
  }

  private queryOf(name: string) {
    return {
      filter: this.state.filterOf(name),
      wholeTable: this.state.wholeTableOf(name),
    };
  }

  private selectionChanged() {
    const { ticked } = this.state;
    const unticked = this.shownTables.filter((name) => !ticked.includes(name));
    const added = ticked.filter((name) => !this.shownTables.includes(name));
    const requeried = ticked.filter(
      (name) =>
        !added.includes(name) &&
        !isEqual(this.shownQueries.get(name), this.queryOf(name)),
    );
    this.shownTables = ticked;
    this.shownQueries = new Map(
      ticked.map((name) => [name, this.queryOf(name)]),
    );
    this.colorSlots = assignColorSlots(this.colorSlots, ticked);
    for (const name of unticked) {
      this.forgetTable(name);
      this.rendered.delete(name);
      this.drawnByTable.delete(name);
      this.stale.delete(name);
      this.clearAnnotations(name);
    }
    for (const name of requeried) {
      this.forgetTable(name);
      this.errors.delete(name);
    }
    for (const name of added) {
      this.errors.delete(name);
      this.annotationState(name).layerState.displayState.color.value =
        vec3.clone(this.tableColor(name));
    }
    if (requeried.length > 0) this.invalidate(requeried);
    this.publishDrawn();
    this.publishStatus();
    this.fetchVisible();
  }

  private tableInfo(name: string): AnnotationTableInfo | undefined {
    return this.tables.value?.find((table) => table.name === name);
  }

  private fetchableTables(): string[] {
    return this.state.ticked.filter(
      (name) => this.tableInfo(name) !== undefined && !this.absent.has(name),
    );
  }

  private shownRoots(): bigint[] {
    const { excludedSegments } = this.state;
    return [...this.connection.visibleSegments].filter(
      (root) => !excludedSegments.has(root),
    );
  }

  private scopes(): AnnotationScope[] {
    const tables = this.fetchableTables();
    return annotationScopes({
      visibleRoots: this.shownRoots(),
      segmentTables: tables.filter((name) => !this.state.wholeTableOf(name)),
      wholeTables: tables.filter((name) => this.state.wholeTableOf(name)),
      coords: this.coords,
      isHeld: (key) => this.cache.has(key) || this.pending.has(key),
    });
  }

  private fetchVisible() {
    if (this.wasDisposed || this.tables.value === undefined) return;
    const scopes = this.scopes();
    const pruned = prunedAnnotationKeys(scopes, this.cache, this.pending);
    for (const key of pruned) this.forgetRoot(key);
    if (pruned.length > 0) this.invalidate(this.state.ticked);
    const totals = annotationTotals(
      scopes,
      this.fetchableTables(),
      this.cache,
      this.hasFailed,
    );
    this.totals.value = totals;
    this.showLimit(annotationLimitNote(totals));
    const requests = planAnnotationFetches({
      scopes,
      cache: this.cache,
      pending: this.pending,
      freeSlots: MAX_ANNOTATION_REQUESTS_IN_FLIGHT - this.running,
      pointsAllowed: totals.complete && totals.total <= MAX_DRAWN_ANNOTATIONS,
    });
    for (const request of requests) void this.send(request);
    this.publishStatus();
  }

  private showLimit(note: string | undefined) {
    if (note === this.limitNote.value) return;
    this.limitNote.value = note;
    this.invalidate(this.state.ticked);
  }

  private read(
    request: AnnotationFetchRequest,
    queries: AnnotationTableQuery[],
    coords: AnnotationReadCoordinates,
  ): Promise<(tables: readonly string[]) => void> {
    const { fetchOkImpl, baseUrl } = this.connection.httpSource;
    const { key, root } = request;
    if (request.phase === "count") {
      return readScope(
        root,
        queries,
        (segment, segmentQueries) =>
          fetchSegmentCounts(
            fetchOkImpl,
            baseUrl,
            segment,
            segmentQueries,
            coords,
          ),
        (query) => fetchTableCount(fetchOkImpl, baseUrl, query, coords),
      ).then(
        (counts) => (tables) =>
          acceptAnnotationCounts(this.cache, { key, tables }, counts),
      );
    }
    return readScope(
      root,
      queries,
      (segment, segmentQueries) =>
        fetchSegmentPoints(
          fetchOkImpl,
          baseUrl,
          segment,
          segmentQueries,
          coords,
        ),
      (query) => fetchTablePoints(fetchOkImpl, baseUrl, query, coords),
    ).then((points) => (tables) => {
      acceptAnnotationPoints(this.cache, { key, tables }, points);
      this.invalidateSettled(tables);
    });
  }

  private async send(request: AnnotationFetchRequest) {
    const requestId = ++this.lastRequest;
    const asked = this.pending.get(request.key) ?? new Map<string, number>();
    for (const table of request.tables) asked.set(table, requestId);
    this.pending.set(request.key, asked);
    const queries = request.tables.map((name) => ({
      table: this.tableInfo(name)!,
      filter: this.state.filterOf(name),
    }));
    // Forgetting a root or a table drops its mark, which retires any answer
    // still on its way for it.
    const stillAsked = () =>
      this.wasDisposed
        ? []
        : request.tables.filter(
            (table) => this.pending.get(request.key)?.get(table) === requestId,
          );
    this.running++;
    try {
      const accept = await this.read(request, queries, this.coords);
      const tables = stillAsked();
      if (tables.length > 0) {
        accept(tables);
        for (const table of tables) {
          asked.delete(table);
          this.errors.delete(table);
          this.rootFailures.clear(table, request.key);
        }
      }
    } catch (error) {
      const tables = stillAsked();
      if (tables.length > 0) this.failed({ ...request, tables }, error, asked);
    } finally {
      this.running--;
      this.fetchVisible();
    }
  }

  private failed(
    request: AnnotationFetchRequest,
    error: unknown,
    asked: Map<string, number>,
  ) {
    const { untick, absent, failed, message } = classifyAnnotationError(
      error,
      request.tables,
      hasExplicitTimestamp(this.coords),
    );
    if (absent.length > 0) {
      for (const table of absent) this.absent.add(table);
      // The others in the request were not read; ask for them again.
      for (const table of request.tables) asked.delete(table);
      this.invalidate(absent);
      return;
    }
    if (untick.length > 0) {
      for (const table of untick) this.errors.set(table, message);
      this.state.untick(...untick);
      return;
    }
    for (const table of failed) {
      this.rootFailures.record(table, request.key, message);
    }
    this.invalidateSettled(failed);
    this.publishStatus();
  }

  private annotationState(name: string): TableAnnotationState {
    let tableState = this.layerStates.get(name);
    if (tableState === undefined) {
      tableState = this.connection.makeAnnotationState(
        ANNOTATION_TABLE_SUBSUBSOURCE_PREFIX + name,
        this.tableColor(name),
        [VALUE_PROPERTY],
        {
          isReadonly: () => this.isReadonly(name),
          onDelete: (annotation) => this.deleteRow(name, annotation),
        },
      );
      this.layerStates.set(name, tableState);
    }
    return tableState;
  }

  private clearAnnotations(name: string) {
    this.layerStates.get(name)?.source.replaceAll([]);
  }

  private nanometresToSource = (nanometres: [number, number, number]) => {
    const point = this.connection.nanometresToSource(nanometres);
    if (point === undefined) {
      throw new Error("The layer's coordinate space has no nanometre scale");
    }
    return point;
  };

  private invalidate(names: readonly string[]) {
    for (const name of names) this.stale.add(name);
    if (this.frameRequested) return;
    this.frameRequested = true;
    this.connection.scheduleFrame(() => this.redrawStale());
  }

  /** A table is redrawn once all of its points are in, not once per answer. */
  private invalidateSettled(names: readonly string[]) {
    const scopes = this.scopes();
    const settled = names.filter((name) =>
      tablePointsSettled(name, scopes, this.cache, this.hasFailed),
    );
    if (settled.length > 0) this.invalidate(settled);
  }

  private hasFailed = (table: string, key: string) =>
    this.rootFailures.has(table, key);

  private redrawStale() {
    this.frameRequested = false;
    if (this.wasDisposed) return;
    const scopes = this.scopes();
    const visibleRoots = new Set(this.connection.visibleSegments);
    for (const name of this.stale) {
      if (this.state.ticked.includes(name)) {
        this.redraw(name, scopes, visibleRoots);
      }
    }
    this.stale.clear();
    this.publishDrawn();
    this.publishStatus();
  }

  private redraw(
    name: string,
    scopes: readonly AnnotationScope[],
    visibleRoots: ReadonlySet<bigint>,
  ) {
    const info = this.tableInfo(name);
    let layerRows: LayerRow[] = [];
    if (info !== undefined && this.limitNote.value === undefined) {
      try {
        layerRows = toLayerAnnotations(
          fetchedTablePoints(name, scopes, this.cache),
          info,
          this.nanometresToSource,
          visibleRoots,
        );
      } catch (error) {
        this.errors.set(name, errorMessage(error));
      }
    }
    this.annotationState(name).source.replaceAll(
      layerRows.flatMap(({ annotations }) => annotations),
    );
    this.showDetails(name);
    this.rendered.set(name, layerRows.length);
    this.drawnByTable.set(
      name,
      layerRows
        .map(({ id, value, annotations }) => ({
          table: name,
          layerId: annotations[0].id,
          id,
          value,
        }))
        .sort((a, b) => compareIds(a.id, b.id)),
    );
  }

  private publishDrawn() {
    this.drawn.value = this.state.ticked.flatMap(
      (name) => this.drawnByTable.get(name) ?? [],
    );
  }

  private tableNote(name: string): string | undefined {
    if (this.absent.has(name)) return TABLE_ABSENT_AT_TIMESTAMP_NOTE;
    const unlistedTick =
      this.tables.value !== undefined &&
      this.state.ticked.includes(name) &&
      this.tableInfo(name) === undefined;
    return unlistedTick ? TABLE_UNLISTED_NOTE : undefined;
  }

  private publishStatus() {
    const scopes = this.scopes();
    const { ticked } = this.state;
    const untickedErrors = [...this.errors.keys()].filter(
      (name) => !ticked.includes(name),
    );
    this.status.value = [...ticked, ...untickedErrors].map((name) =>
      annotationTableStatus({
        table: name,
        fetched: fetchedTablePoints(name, scopes, this.cache),
        annotations: this.rendered.get(name) ?? 0,
        error: this.errors.get(name) ?? this.rootFailures.messageFor(name),
        note: this.tableNote(name),
      }),
    );
    this.rootsNote.value =
      ticked.length > 0
        ? visibleRootsNote(this.shownRoots().length)
        : undefined;
  }
}
