/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { chunk, debounce } from "lodash-es";
import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type {
  AnnotationPropertySpec,
  AnnotationSource,
} from "#src/annotation/index.js";
import {
  colorForTable,
  toLayerAnnotations,
} from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import type {
  AnnotationTableInfo,
  SchemaPointsCache,
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
  truncatedRoots: number;
  error?: string;
  note?: string;
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

function compareRoots(a: bigint, b: bigint): number {
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
  const sorted = [...new Set(visible)].sort(compareRoots);
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
  pending: ReadonlyMap<string, ReadonlySet<string>>;
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

/** Stores a response unless the session moved on since it was sent. */
export function acceptAnnotationResponse(
  cache: Map<string, SegmentAnnotations>,
  request: AnnotationFetchRequest & { token: number },
  currentToken: number,
  response: SegmentAnnotations,
): boolean {
  if (request.token !== currentToken) return false;
  const stored = cache.get(request.key) ?? {
    rootId: response.rootId,
    tables: new Map(),
  };
  for (const table of request.tables) {
    stored.tables.set(
      table,
      response.tables.get(table) ?? { annotations: [], truncated: false },
    );
  }
  cache.set(request.key, stored);
  return true;
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

export function annotationTableStatus(
  table: string,
  byRoot: ReadonlyMap<bigint, SegmentAnnotations>,
  annotations: number,
  error: string | undefined,
  note?: string,
): AnnotationTableStatus {
  let fetchedRoots = 0;
  let truncatedRoots = 0;
  for (const response of byRoot.values()) {
    const fetched = response.tables.get(table);
    if (fetched === undefined) continue;
    fetchedRoots++;
    if (fetched.truncated) truncatedRoots++;
  }
  return {
    table,
    annotations,
    fetchedRoots,
    truncatedRoots,
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
}

export class CalcadaAnnotationTablesSession extends RefCounted {
  readonly tables = new WatchableValue<AnnotationTableInfo[] | undefined>(
    undefined,
  );
  readonly status = new WatchableValue<AnnotationTableStatus[]>([]);
  readonly listError = new WatchableValue<string | undefined>(undefined);
  readonly rootsNote = new WatchableValue<string | undefined>(undefined);
  private readonly schemaPoints: SchemaPointsCache = new Map();
  private readonly cache = new Map<string, SegmentAnnotations>();
  // Tables asked for per cache key since the last reset: in flight, or failed
  // and not to be retried until something changes.
  private readonly pending = new Map<string, Set<string>>();
  private readonly layerStates = new Map<string, AnnotationLayerState>();
  private readonly rendered = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly rootFailures = new RootFailures();
  // Tables the server does not have at the explicit timestamp in view.
  private readonly absent = new Set<string>();
  private colorSlots = new Map<string, number>();
  private shownTables: readonly string[] = [];
  private token = 0;
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
    this.registerDisposer(state.changed.add(() => this.tickedChanged()));
    this.tickedChanged();
    this.refreshTables();
  }

  refreshTables() {
    const token = ++this.tablesToken;
    const { fetchOkImpl, baseUrl } = this.connection.httpSource;
    retryOnceIfUnauthorized(() =>
      listAnnotationTables(fetchOkImpl, baseUrl, this.schemaPoints),
    ).then(
      (tables) => {
        if (token !== this.tablesToken || this.wasDisposed) return;
        this.listError.value = undefined;
        this.tables.value = tables;
        this.untickUnlisted();
        this.renderTables(this.state.ticked);
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
    this.token++;
    this.cache.clear();
    this.pending.clear();
    this.rootFailures.reset();
    this.absent.clear();
    for (const table of this.state.ticked) this.errors.delete(table);
    this.renderTables(this.state.ticked);
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
    this.renderTables(this.state.ticked);
    this.refetch();
  }

  private forgetRoot(key: string) {
    this.cache.delete(key);
    this.pending.delete(key);
    this.rootFailures.dropRoot(key);
  }

  private tickedChanged() {
    const { ticked } = this.state;
    const unticked = this.shownTables.filter((name) => !ticked.includes(name));
    const added = ticked.filter((name) => !this.shownTables.includes(name));
    this.shownTables = ticked;
    this.colorSlots = assignColorSlots(this.colorSlots, ticked);
    if (unticked.length > 0) {
      this.token++;
      this.pending.clear();
      for (const name of unticked) this.rootFailures.dropTable(name);
      for (const cached of this.cache.values()) {
        for (const name of unticked) cached.tables.delete(name);
      }
      for (const name of unticked) {
        this.rendered.delete(name);
        this.clearAnnotations(name);
      }
    }
    for (const name of added) {
      this.errors.delete(name);
      this.annotationState(name).displayState.color.value = vec3.clone(
        this.tableColor(name),
      );
    }
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
    if (plan.prune.length > 0) this.renderTables(this.state.ticked);
    for (const request of plan.requests) void this.send(request);
    this.publishStatus();
  }

  private async send(request: AnnotationFetchRequest) {
    const token = this.token;
    const coords = this.coords;
    const asked = this.pending.get(request.key) ?? new Set<string>();
    for (const table of request.tables) asked.add(table);
    this.pending.set(request.key, asked);
    const infos = request.tables.map((name) => this.tableInfo(name)!);
    const { fetchOkImpl, baseUrl } = this.connection.httpSource;
    // Forgetting a root (pruned or edited) replaces its pending set, which
    // retires any answer still on its way for it.
    const isCurrent = () =>
      !this.wasDisposed &&
      token === this.token &&
      this.pending.get(request.key) === asked;
    this.running++;
    try {
      const response = await fetchSegmentAnnotations(
        fetchOkImpl,
        baseUrl,
        request.root,
        infos,
        coords,
        this.schemaPoints,
      );
      if (
        isCurrent() &&
        acceptAnnotationResponse(
          this.cache,
          { ...request, token },
          this.token,
          response,
        )
      ) {
        for (const table of request.tables) {
          asked.delete(table);
          this.errors.delete(table);
          this.rootFailures.clear(table, request.key);
        }
        this.renderTables(request.tables);
      }
    } catch (error) {
      if (isCurrent()) this.failed(request, error, asked);
    } finally {
      this.running--;
      this.fetchVisible();
    }
  }

  private failed(
    request: AnnotationFetchRequest,
    error: unknown,
    asked: Set<string>,
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
      this.renderTables(absent);
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
      (layerState.source as AnnotationSource).clear();
    }
  }

  private nanometresToSource = (nanometres: [number, number, number]) => {
    const point = this.connection.nanometresToSource(nanometres);
    if (point === undefined) {
      throw new Error("The layer's coordinate space has no nanometre scale");
    }
    return point;
  };

  private renderTables(names: readonly string[]) {
    const byRoot = cachedAnnotationsByRoot(
      this.cache,
      this.coords,
      this.connection.visibleSegments,
    );
    for (const name of names) {
      if (!this.state.ticked.includes(name)) continue;
      const info = this.tableInfo(name);
      const source = this.annotationState(name).source as AnnotationSource;
      source.clear();
      let count = 0;
      if (info !== undefined) {
        try {
          for (const annotation of toLayerAnnotations(
            byRoot,
            info,
            this.nanometresToSource,
          )) {
            source.add(annotation, true);
            count++;
          }
        } catch (error) {
          this.errors.set(
            name,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      this.rendered.set(name, count);
    }
    this.publishStatus();
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
    const byRoot = cachedAnnotationsByRoot(
      this.cache,
      this.coords,
      this.connection.visibleSegments,
    );
    const { ticked } = this.state;
    const untickedErrors = [...this.errors.keys()].filter(
      (name) => !ticked.includes(name),
    );
    this.status.value = [...ticked, ...untickedErrors].map((name) =>
      annotationTableStatus(
        name,
        byRoot,
        this.rendered.get(name) ?? 0,
        this.errors.get(name) ?? this.rootFailures.messageFor(name),
        this.tableNote(name),
      ),
    );
    this.rootsNote.value =
      ticked.length > 0 ? this.visibleRootsNote() : undefined;
  }
}
