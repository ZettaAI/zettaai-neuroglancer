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
  AnnotationSource,
} from "#src/annotation/index.js";
import {
  FIRST_PAGE,
  PageWindows,
} from "#src/datasource/calcada/annotation_tables/annotation_page_windows.js";
import type { LayerRow } from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import {
  colorForTable,
  syncAnnotationSource,
  toLayerAnnotations,
} from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import type {
  AnnotationTableFilter,
  AnnotationTableInfo,
  SchemaCache,
  SegmentAnnotation,
  SegmentAnnotations,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import {
  AnnotationTableForbidden,
  AnnotationTableMissing,
  MAX_TABLES_PER_SEGMENT_REQUEST,
  fetchSegmentAnnotations,
  listAnnotationTables,
  retryOnceIfUnauthorized,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { CalcadaAnnotationTablesState } from "#src/datasource/calcada/annotation_tables/annotation_tables_state.js";
import type { HttpSource } from "#src/datasource/calcada/base.js";
import { hasExplicitTimestamp } from "#src/datasource/calcada/graph_coordinates.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import type { ReadonlySignal } from "#src/util/signal.js";

export const MAX_ANNOTATION_ROOTS = 50;
/** Drawn per table per root, and sent as the page `limit`. */
export const ANNOTATIONS_PER_PAGE = 1000;
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

export interface GraphCoordinates {
  branchId: number;
  timestamp: number;
}

export interface AnnotationFetchRequest {
  key: string;
  root: bigint;
  tables: string[];
}

export interface AnnotationFetchPlan {
  requests: AnnotationFetchRequest[];
  prune: string[];
}

export interface AnnotationTableStatus {
  table: string;
  annotations: number;
  fetchedRoots: number;
  /** 1-based: the deepest page any of the table's roots is on. */
  page: number;
  hasNext: boolean;
  hasPrevious: boolean;
  error?: string;
  note?: string;
}

export interface DrawnAnnotation {
  table: string;
  annotation: SegmentAnnotation;
  /** The id of its (first) annotation in the table's annotation state. */
  layerId: string;
}

export interface AnnotationFetchFailure {
  untick: string[];
  absent: string[];
  failed: string[];
  message: string;
}

export function annotationCacheKey(
  { branchId, timestamp }: GraphCoordinates,
  root: bigint,
): string {
  return `${branchId}|${timestamp}|${root}`;
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
 * Per table, the message of each root whose fetch failed: one root's later
 * success must not hide another root's failure.
 */
export class RootFailures {
  private readonly byTable = new Map<string, Map<string, string>>();

  record(table: string, key: string, message: string) {
    const failures = this.byTable.get(table) ?? new Map<string, string>();
    failures.set(key, message);
    this.byTable.set(table, failures);
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

export function planAnnotationFetches(input: {
  visibleRoots: Iterable<bigint>;
  ticked: readonly string[];
  coords: GraphCoordinates;
  cache: ReadonlyMap<string, SegmentAnnotations>;
  pending: ReadonlyMap<string, ReadonlyMap<string, number>>;
  freeSlots: number;
}): AnnotationFetchPlan {
  const { ticked, coords, cache, pending, freeSlots } = input;
  const roots = visibleAnnotationRoots(input.visibleRoots, (root) => {
    const key = annotationCacheKey(coords, root);
    return cache.has(key) || pending.has(key);
  });
  const wanted = new Set(roots.map((root) => annotationCacheKey(coords, root)));
  const prune = [...new Set([...cache.keys(), ...pending.keys()])].filter(
    (key) => !wanted.has(key),
  );
  const requests: AnnotationFetchRequest[] = [];
  for (const root of roots) {
    const key = annotationCacheKey(coords, root);
    const tables = ticked.filter(
      (table) =>
        !cache.get(key)?.tables.has(table) && !pending.get(key)?.has(table),
    );
    for (const group of chunk(tables, MAX_TABLES_PER_SEGMENT_REQUEST)) {
      if (requests.length >= freeSlots) return { requests, prune };
      requests.push({ key, root, tables: group });
    }
  }
  return { requests, prune };
}

export function acceptAnnotationResponse(
  cache: Map<string, SegmentAnnotations>,
  request: AnnotationFetchRequest,
  response: SegmentAnnotations,
) {
  const stored = cache.get(request.key) ?? {
    rootId: response.rootId,
    tables: new Map(),
  };
  for (const table of request.tables) {
    stored.tables.set(table, response.tables.get(table) ?? { annotations: [] });
  }
  cache.set(request.key, stored);
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
  const message = error instanceof Error ? error.message : String(error);
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

export function cachedAnnotationsByRoot(
  cache: ReadonlyMap<string, SegmentAnnotations>,
  coords: GraphCoordinates,
  visibleRoots: Iterable<bigint>,
): Map<bigint, SegmentAnnotations> {
  const byRoot = new Map<bigint, SegmentAnnotations>();
  const isCached = (root: bigint) =>
    cache.has(annotationCacheKey(coords, root));
  for (const root of visibleAnnotationRoots(visibleRoots, isCached)) {
    const cached = cache.get(annotationCacheKey(coords, root));
    if (cached !== undefined) byRoot.set(root, cached);
  }
  return byRoot;
}

export function annotationTableStatus(input: {
  table: string;
  byRoot: ReadonlyMap<bigint, SegmentAnnotations>;
  annotations: number;
  windows?: PageWindows;
  error?: string;
  note?: string;
}): AnnotationTableStatus {
  const { table, byRoot, annotations, windows, error, note } = input;
  let fetchedRoots = 0;
  let hasNext = false;
  for (const response of byRoot.values()) {
    const fetched = response.tables.get(table);
    if (fetched === undefined) continue;
    fetchedRoots++;
    if (fetched.nextCursor !== undefined) hasNext = true;
  }
  return {
    table,
    annotations,
    fetchedRoots,
    page: windows?.page ?? FIRST_PAGE,
    hasNext,
    hasPrevious: windows?.hasPrevious ?? false,
    ...(error === undefined ? {} : { error }),
    ...(note === undefined ? {} : { note }),
  };
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
  ): AnnotationLayerState;
  selectAnnotation(state: AnnotationLayerState, annotation: Annotation): void;
  moveToAnnotation(state: AnnotationLayerState, annotation: Annotation): void;
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
  private readonly schemas: SchemaCache = new Map();
  private readonly cache = new Map<string, SegmentAnnotations>();
  // Per cache key, the request each table was last asked in: in flight, or
  // failed and not to be retried until something changes. An answer counts
  // only for the tables still marked with its request.
  private readonly pending = new Map<string, Map<string, number>>();
  private readonly windows = new Map<string, PageWindows>();
  private readonly layerStates = new Map<string, AnnotationLayerState>();
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
  private shownFilters = new Map<string, AnnotationTableFilter | undefined>();
  private lastRequest = 0;
  private tablesToken = 0;
  private running = 0;
  private coords: GraphCoordinates;
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
        this.listError.value = `Could not list annotation tables: ${
          error instanceof Error ? error.message : String(error)
        }`;
      },
    );
  }

  /** Moves every root of the table that has more onto its next page. */
  nextPage(table: string) {
    const next = new Map<string, string>();
    for (const [root, cached] of this.visibleCached()) {
      const cursor = cached.tables.get(table)?.nextCursor;
      if (cursor !== undefined) {
        next.set(annotationCacheKey(this.coords, root), cursor);
      }
    }
    if (next.size === 0) return;
    this.windowsOf(table).advance(next);
    this.turnPage(table, next.keys());
  }

  previousPage(table: string) {
    const moved = this.windows.get(table)?.back() ?? [];
    if (moved.length > 0) this.turnPage(table, moved);
  }

  select(item: DrawnAnnotation) {
    const found = this.findDrawn(item);
    if (found === undefined) return;
    this.connection.selectAnnotation(found.layerState, found.annotation);
  }

  moveTo(item: DrawnAnnotation) {
    const found = this.findDrawn(item);
    if (found === undefined) return;
    this.connection.selectAnnotation(found.layerState, found.annotation);
    this.connection.moveToAnnotation(found.layerState, found.annotation);
  }

  private findDrawn({ table, layerId }: DrawnAnnotation) {
    if (!this.state.ticked.includes(table)) return undefined;
    const layerState = this.layerStates.get(table);
    const annotation = (
      layerState?.source as AnnotationSource | undefined
    )?.get(layerId);
    if (layerState === undefined || annotation === undefined) return undefined;
    return { layerState, annotation };
  }

  private windowsOf(table: string): PageWindows {
    let windows = this.windows.get(table);
    if (windows === undefined) {
      windows = new PageWindows();
      this.windows.set(table, windows);
    }
    return windows;
  }

  private turnPage(table: string, keys: Iterable<string>) {
    for (const key of keys) {
      this.cache.get(key)?.tables.delete(table);
      this.pending.get(key)?.delete(table);
      this.rootFailures.clear(table, key);
    }
    this.invalidate([table]);
    this.fetchVisible();
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

  private currentCoordinates(): GraphCoordinates {
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
    this.windows.clear();
    this.rootFailures.reset();
    this.absent.clear();
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
    for (const windows of this.windows.values()) windows.forget(key);
  }

  /** Back to nothing fetched for the table: no page, no request, no failure. */
  private forgetTable(name: string) {
    for (const cached of this.cache.values()) cached.tables.delete(name);
    for (const asked of this.pending.values()) asked.delete(name);
    this.windows.delete(name);
    this.rootFailures.dropTable(name);
  }

  private selectionChanged() {
    const { ticked } = this.state;
    const unticked = this.shownTables.filter((name) => !ticked.includes(name));
    const added = ticked.filter((name) => !this.shownTables.includes(name));
    const refiltered = ticked.filter(
      (name) =>
        !added.includes(name) &&
        !isEqual(this.shownFilters.get(name), this.state.filterOf(name)),
    );
    this.shownTables = ticked;
    this.shownFilters = new Map(
      ticked.map((name) => [name, this.state.filterOf(name)]),
    );
    this.colorSlots = assignColorSlots(this.colorSlots, ticked);
    for (const name of unticked) {
      this.forgetTable(name);
      this.rendered.delete(name);
      this.drawnByTable.delete(name);
      this.stale.delete(name);
      this.clearAnnotations(name);
    }
    for (const name of refiltered) {
      this.forgetTable(name);
      this.errors.delete(name);
    }
    for (const name of added) {
      this.errors.delete(name);
      this.annotationState(name).displayState.color.value = vec3.clone(
        this.tableColor(name),
      );
    }
    if (refiltered.length > 0) this.invalidate(refiltered);
    this.publishDrawn();
    this.publishStatus();
    this.fetchVisible();
  }

  private tableInfo(name: string): AnnotationTableInfo | undefined {
    return this.tables.value?.find((table) => table.name === name);
  }

  private fetchVisible() {
    if (this.wasDisposed || this.tables.value === undefined) return;
    const ticked = this.state.ticked.filter(
      (name) => this.tableInfo(name) !== undefined && !this.absent.has(name),
    );
    const plan = planAnnotationFetches({
      visibleRoots: this.connection.visibleSegments,
      ticked,
      coords: this.coords,
      cache: this.cache,
      pending: this.pending,
      freeSlots: MAX_ANNOTATION_REQUESTS_IN_FLIGHT - this.running,
    });
    for (const key of plan.prune) this.forgetRoot(key);
    if (plan.prune.length > 0) this.invalidate(this.state.ticked);
    for (const request of plan.requests) void this.send(request);
    this.publishStatus();
  }

  private async send(request: AnnotationFetchRequest) {
    const requestId = ++this.lastRequest;
    const coords = this.coords;
    const asked = this.pending.get(request.key) ?? new Map<string, number>();
    for (const table of request.tables) asked.set(table, requestId);
    this.pending.set(request.key, asked);
    const queries = request.tables.map((name) => ({
      table: this.tableInfo(name)!,
      filter: this.state.filterOf(name),
      afterId: this.windows.get(name)?.cursor(request.key),
      limit: ANNOTATIONS_PER_PAGE,
    }));
    const { fetchOkImpl, baseUrl } = this.connection.httpSource;
    // Forgetting a root, a table or a page drops its mark, which retires any
    // answer still on its way for it.
    const stillAsked = () =>
      this.wasDisposed
        ? []
        : request.tables.filter(
            (table) => this.pending.get(request.key)?.get(table) === requestId,
          );
    this.running++;
    try {
      const response = await fetchSegmentAnnotations(
        fetchOkImpl,
        baseUrl,
        request.root,
        queries,
        coords,
        this.schemas,
      );
      const tables = stillAsked();
      if (tables.length > 0) {
        acceptAnnotationResponse(this.cache, { ...request, tables }, response);
        for (const table of tables) {
          asked.delete(table);
          this.errors.delete(table);
          this.rootFailures.clear(table, request.key);
        }
        this.invalidate(tables);
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
    this.publishStatus();
  }

  private annotationState(name: string): AnnotationLayerState {
    let layerState = this.layerStates.get(name);
    if (layerState === undefined) {
      layerState = this.connection.makeAnnotationState(
        ANNOTATION_TABLE_SUBSUBSOURCE_PREFIX + name,
        this.tableColor(name),
        [VALUE_PROPERTY],
      );
      this.layerStates.set(name, layerState);
    }
    return layerState;
  }

  tableColor(name: string): vec3 {
    return colorForTable(this.colorSlots.get(name) ?? 0);
  }

  private clearAnnotations(name: string) {
    const layerState = this.layerStates.get(name);
    if (layerState !== undefined) {
      syncAnnotationSource(layerState.source as AnnotationSource, []);
    }
  }

  private nanometresToSource = (nanometres: [number, number, number]) => {
    const point = this.connection.nanometresToSource(nanometres);
    if (point === undefined) {
      throw new Error("The layer's coordinate space has no nanometre scale");
    }
    return point;
  };

  private visibleCached(): Map<bigint, SegmentAnnotations> {
    return cachedAnnotationsByRoot(
      this.cache,
      this.coords,
      this.connection.visibleSegments,
    );
  }

  private invalidate(names: readonly string[]) {
    for (const name of names) this.stale.add(name);
    if (this.frameRequested) return;
    this.frameRequested = true;
    this.connection.scheduleFrame(() => this.redrawStale());
  }

  private redrawStale() {
    this.frameRequested = false;
    if (this.wasDisposed) return;
    const byRoot = this.visibleCached();
    for (const name of this.stale) {
      if (this.state.ticked.includes(name)) this.redraw(name, byRoot);
    }
    this.stale.clear();
    this.publishDrawn();
    this.publishStatus();
  }

  private redraw(name: string, byRoot: Map<bigint, SegmentAnnotations>) {
    const info = this.tableInfo(name);
    let layerRows: LayerRow[] = [];
    if (info !== undefined) {
      try {
        layerRows = toLayerAnnotations(byRoot, info, this.nanometresToSource);
      } catch (error) {
        this.errors.set(
          name,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    syncAnnotationSource(
      this.annotationState(name).source as AnnotationSource,
      layerRows.flatMap(({ annotations }) => annotations),
    );
    this.rendered.set(name, layerRows.length);
    this.drawnByTable.set(
      name,
      layerRows
        .map(({ row, annotations }) => ({
          table: name,
          annotation: row,
          layerId: annotations[0].id,
        }))
        .sort((a, b) => compareIds(a.annotation.id, b.annotation.id)),
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

  private visibleRootsNote(): string | undefined {
    return visibleRootsNote(new Set(this.connection.visibleSegments).size);
  }

  private publishStatus() {
    const byRoot = this.visibleCached();
    const { ticked } = this.state;
    const untickedErrors = [...this.errors.keys()].filter(
      (name) => !ticked.includes(name),
    );
    this.status.value = [...ticked, ...untickedErrors].map((name) =>
      annotationTableStatus({
        table: name,
        byRoot,
        annotations: this.rendered.get(name) ?? 0,
        windows: this.windows.get(name),
        error: this.errors.get(name) ?? this.rootFailures.messageFor(name),
        note: this.tableNote(name),
      }),
    );
    this.rootsNote.value =
      ticked.length > 0 ? this.visibleRootsNote() : undefined;
  }
}
