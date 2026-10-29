/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type {
  AnnotationTableFilter,
  TablePoints,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import {
  AnnotationTableForbidden,
  AnnotationTableMissing,
  MAX_TABLES_PER_SEGMENT_REQUEST,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type {
  AnnotationScope,
  AnnotationScopeEntry,
  AnnotationTablesConnection,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import {
  CalcadaAnnotationTablesSession,
  MAX_ANNOTATION_ROOTS,
  MAX_DRAWN_ANNOTATIONS,
  RootFailures,
  TABLE_ABSENT_AT_TIMESTAMP_NOTE,
  TABLE_UNLISTED_NOTE,
  VISIBLE_SEGMENTS_DEBOUNCE_MS,
  acceptAnnotationCounts,
  acceptAnnotationPoints,
  annotationCacheKey,
  annotationLimitNote,
  annotationScopes,
  annotationTotals,
  assignColorSlots,
  classifyAnnotationError,
  describeAnnotationRow,
  planAnnotationFetches,
  visibleAnnotationRoots,
  visibleRootsNote,
  wholeTableCacheKey,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { CalcadaAnnotationTablesState } from "#src/datasource/calcada/annotation_tables/annotation_tables_state.js";
import { CalcadaTableAnnotationSource } from "#src/datasource/calcada/annotation_tables/table_annotation_source.js";
import { WatchableValue } from "#src/trackable_value.js";
import type {
  AnnotationListColumnWidths,
  SelectedListAnnotation,
} from "#src/ui/annotations.js";
import { Uint64Set } from "#src/uint64_set.js";
import { vec3 } from "#src/util/geom.js";
import { HttpError } from "#src/util/http_request.js";
import { Signal } from "#src/util/signal.js";

const MAIN = { branchId: 0, timestamp: 0 };

const roots = (count: number) =>
  Array.from({ length: count }, (_, i) => BigInt(i + 1));

const NO_POINTS: TablePoints = {
  ids: [],
  values: new Float64Array(),
  roots: [],
  points: [],
};

const entry = (
  counts: Record<string, number>,
  points: string[] = [],
): AnnotationScopeEntry => ({
  counts: new Map(Object.entries(counts)),
  points: new Map(points.map((table) => [table, NO_POINTS])),
});

const rootScopes = (
  visible: bigint[],
  segmentTables: string[],
  wholeTables: string[] = [],
  isHeld: (key: string) => boolean = () => false,
) =>
  annotationScopes({
    visibleRoots: visible,
    segmentTables,
    wholeTables,
    coords: MAIN,
    isHeld,
  });

const plan = (
  overrides: Partial<Parameters<typeof planAnnotationFetches>[0]> = {},
) =>
  planAnnotationFetches({
    scopes: rootScopes([10n], ["syn"]),
    cache: new Map(),
    pending: new Map(),
    freeSlots: MAX_ANNOTATION_ROOTS,
    pointsAllowed: true,
    ...overrides,
  });

describe("annotationScopes", () => {
  it("is one scope per visible root for the segment tables, then one per whole table", () => {
    expect(rootScopes([20n, 10n], ["syn"], ["mark"])).toEqual([
      { key: "0|0|10", root: 10n, tables: ["syn"] },
      { key: "0|0|20", root: 20n, tables: ["syn"] },
      { key: "0|0|table:mark", root: undefined, tables: ["mark"] },
    ]);
  });

  it("looks at no more than the first fifty visible roots", () => {
    const scopes = rootScopes(roots(MAX_ANNOTATION_ROOTS + 7), ["syn"]);
    expect(scopes).toHaveLength(MAX_ANNOTATION_ROOTS);
    expect(scopes.at(-1)?.root).toBe(BigInt(MAX_ANNOTATION_ROOTS));
  });

  it("keeps held roots in the capped subset and fills it by ascending id", () => {
    const visible = roots(MAX_ANNOTATION_ROOTS + 10).reverse();
    const held = BigInt(MAX_ANNOTATION_ROOTS + 5);
    const shown = visibleAnnotationRoots(visible, (root) => root === held);
    expect(shown).toHaveLength(MAX_ANNOTATION_ROOTS);
    expect(shown[0]).toBe(held);
    expect(shown.slice(1)).toEqual(roots(MAX_ANNOTATION_ROOTS - 1));
  });

  it("keys the cache by branch, timestamp and root or table", () => {
    expect(annotationCacheKey({ branchId: 2, timestamp: 1500 }, 7n)).toBe(
      "2|1500|7",
    );
    expect(wholeTableCacheKey({ branchId: 2, timestamp: 1500 }, "syn")).toBe(
      "2|1500|table:syn",
    );
  });
});

describe("planAnnotationFetches", () => {
  it("counts every scope before asking for points", () => {
    expect(
      plan({ scopes: rootScopes([10n, 20n], ["syn", "mark"], ["whole"]) }),
    ).toEqual([
      { key: "0|0|10", root: 10n, tables: ["syn", "mark"], phase: "count" },
      { key: "0|0|20", root: 20n, tables: ["syn", "mark"], phase: "count" },
      {
        key: "0|0|table:whole",
        root: undefined,
        tables: ["whole"],
        phase: "count",
      },
    ]);
  });

  it("asks for the points of what is counted and not yet read", () => {
    const cache = new Map([["0|0|10", entry({ syn: 4, mark: 2 }, ["mark"])]]);
    expect(plan({ cache, scopes: rootScopes([10n], ["syn", "mark"]) })).toEqual(
      [{ key: "0|0|10", root: 10n, tables: ["syn"], phase: "points" }],
    );
    expect(
      plan({
        cache,
        scopes: rootScopes([10n], ["syn", "mark"]),
        pointsAllowed: false,
      }),
    ).toEqual([]);
  });

  it("splits a root's tables into groups the server accepts", () => {
    const ticked = Array.from(
      { length: 2 * MAX_TABLES_PER_SEGMENT_REQUEST + 5 },
      (_, i) => `t${i}`,
    );
    const scopes = rootScopes([10n], ticked);
    expect(plan({ scopes }).map((request) => request.tables)).toEqual([
      ticked.slice(0, MAX_TABLES_PER_SEGMENT_REQUEST),
      ticked.slice(
        MAX_TABLES_PER_SEGMENT_REQUEST,
        2 * MAX_TABLES_PER_SEGMENT_REQUEST,
      ),
      ticked.slice(2 * MAX_TABLES_PER_SEGMENT_REQUEST),
    ]);
    expect(plan({ scopes, freeSlots: 2 })).toHaveLength(2);
  });

  it("sends no more requests than there are free slots", () => {
    const scopes = rootScopes(roots(10), ["syn"]);
    expect(plan({ scopes, freeSlots: 4 })).toHaveLength(4);
    expect(plan({ scopes, freeSlots: 0 })).toEqual([]);
  });

  it("does not ask again for what is already on its way", () => {
    const pending = new Map([["0|0|10", new Map([["syn", 1]])]]);
    expect(plan({ pending })).toEqual([]);
  });
});

describe("acceptAnnotationCounts and acceptAnnotationPoints", () => {
  const request = { key: "0|0|10", tables: ["syn", "mark"] };

  it("counts a table the server left out as zero, which needs no points", () => {
    const cache = new Map<string, AnnotationScopeEntry>();
    acceptAnnotationCounts(cache, request, new Map([["syn", 3]]));
    const stored = cache.get("0|0|10")!;
    expect(stored.counts).toEqual(
      new Map([
        ["syn", 3],
        ["mark", 0],
      ]),
    );
    expect([...stored.points.keys()]).toEqual(["mark"]);
  });

  it("adds the points of a table to what the scope already had", () => {
    const cache = new Map([["0|0|10", entry({ syn: 1, mark: 1 }, ["syn"])]]);
    acceptAnnotationPoints(
      cache,
      { key: "0|0|10", tables: ["mark"] },
      new Map(),
    );
    expect([...cache.get("0|0|10")!.points.keys()]).toEqual(["syn", "mark"]);
  });
});

describe("annotationTotals and annotationLimitNote", () => {
  const scopes: AnnotationScope[] = rootScopes([10n, 20n], ["syn"], ["mark"]);
  const noFailures = () => false;

  it("sums per table in the given order and is complete once all are known", () => {
    const cache = new Map([
      ["0|0|10", entry({ syn: 2 })],
      ["0|0|20", entry({ syn: 3 })],
      ["0|0|table:mark", entry({ mark: 7 })],
    ]);
    expect(
      annotationTotals(scopes, ["mark", "syn"], cache, noFailures),
    ).toEqual({
      complete: true,
      total: 12,
      byTable: new Map([
        ["mark", 7],
        ["syn", 5],
      ]),
    });
  });

  it("is incomplete while a count is missing, unless that count failed", () => {
    const cache = new Map([["0|0|10", entry({ syn: 2 })]]);
    expect(annotationTotals(scopes, ["syn"], cache, noFailures).complete).toBe(
      false,
    );
    expect(
      annotationTotals(scopes, ["syn"], cache, (_, key) => key === "0|0|20")
        .complete,
    ).toBe(true);
  });

  it("names the tables only beyond the limit", () => {
    const totals = (syn: number, mark: number) => ({
      complete: true,
      total: syn + mark,
      byTable: new Map([
        ["syn", syn],
        ["mark", mark],
        ["empty", 0],
      ]),
    });
    expect(annotationLimitNote(totals(MAX_DRAWN_ANNOTATIONS, 0))).toBe(
      undefined,
    );
    expect(annotationLimitNote(totals(600_000, 400_001))).toBe(
      "More than 1 000 000 annotations in the selected tables (syn: 600 000, mark: 400 001). Add a filter or deselect a table.",
    );
  });
});

describe("describeAnnotationRow", () => {
  it("is one line per payload field, then the id", () => {
    expect(
      describeAnnotationRow({
        id: 9007199254740993n,
        value: 0,
        payload: { tag: "soma", size: 3, flags: [1, 2] },
        points: [],
      }),
    ).toBe("tag: soma\nsize: 3\nflags: [1,2]\nid: 9007199254740993");
  });
});

describe("classifyAnnotationError", () => {
  it("unticks a table the server forbids and leaves the others ticked", () => {
    expect(
      classifyAnnotationError(
        new AnnotationTableForbidden("syn"),
        ["syn", "mark"],
        false,
      ),
    ).toEqual({
      untick: ["syn"],
      absent: [],
      failed: ["syn"],
      message: "No read permission on annotation table syn",
    });
  });

  it("unticks a table missing from the live graph", () => {
    expect(
      classifyAnnotationError(
        new AnnotationTableMissing("mark"),
        ["syn", "mark"],
        false,
      ).untick,
    ).toEqual(["mark"]);
  });

  it("keeps the tick of a table missing at an explicit timestamp", () => {
    expect(
      classifyAnnotationError(
        new AnnotationTableMissing("mark"),
        ["syn", "mark"],
        true,
      ),
    ).toEqual({
      untick: [],
      absent: ["mark"],
      failed: [],
      message: "Annotation table mark not found",
    });
  });

  it("unticks a forbidden table at an explicit timestamp too", () => {
    expect(
      classifyAnnotationError(
        new AnnotationTableForbidden("syn"),
        ["syn"],
        true,
      ).untick,
    ).toEqual(["syn"]);
  });

  it("unticks every requested table when the server names none of them", () => {
    expect(
      classifyAnnotationError(
        new AnnotationTableForbidden("syn,mark"),
        ["syn", "mark"],
        false,
      ).untick,
    ).toEqual(["syn", "mark"]);
  });

  it("keeps the ticks on any other failure", () => {
    expect(
      classifyAnnotationError(new Error("boom"), ["syn", "mark"], true),
    ).toEqual({
      untick: [],
      absent: [],
      failed: ["syn", "mark"],
      message: "boom",
    });
  });
});

describe("assignColorSlots", () => {
  it("keeps a ticked table's colour and gives a new one the lowest free slot", () => {
    const first = assignColorSlots(new Map(), ["a", "b", "c"]);
    expect([...first]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    const afterUntick = assignColorSlots(first, ["b", "c"]);
    expect(afterUntick.get("b")).toBe(1);
    expect(assignColorSlots(afterUntick, ["b", "c", "d"]).get("d")).toBe(0);
  });
});

describe("visibleRootsNote", () => {
  it("says nothing up to the root limit", () => {
    expect(visibleRootsNote(MAX_ANNOTATION_ROOTS)).toBeUndefined();
  });

  it("names the cap and the visible count beyond it", () => {
    expect(visibleRootsNote(120)).toBe(
      "Showing annotations for 50 of 120 visible segments.",
    );
  });
});

describe("RootFailures", () => {
  it("keeps one root's failure when another root succeeds", () => {
    const failures = new RootFailures();
    failures.record("t", "a", "boom");
    failures.clear("t", "b");
    expect(failures.messageFor("t")).toBe("boom");
  });

  it("clears the failure when that root succeeds", () => {
    const failures = new RootFailures();
    failures.record("t", "a", "boom");
    failures.clear("t", "a");
    expect(failures.messageFor("t")).toBeUndefined();
  });

  it("forgets a pruned root, an unticked table and everything on reset", () => {
    const failures = new RootFailures();
    failures.record("t", "a", "boom");
    failures.record("u", "a", "bang");
    failures.record("v", "b", "crash");
    failures.dropRoot("a");
    expect(failures.messageFor("t")).toBeUndefined();
    expect(failures.messageFor("u")).toBeUndefined();
    failures.dropTable("v");
    expect(failures.messageFor("v")).toBeUndefined();
    failures.record("t", "a", "boom");
    failures.reset();
    expect(failures.messageFor("t")).toBeUndefined();
  });
});

const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const ROUTER_NOT_FOUND_BODY = "404 page not found";
const EXPLICIT_TIMESTAMP_MS = 1_500;
const SEGMENT_URL = /\/annotation\/segment\/(\d+)\/(count|points)(?:\?|$)/;
const TABLE_URL = /\/annotation\/tables\/([^/?]+)\/(count|points|annotations)/;
const ROW_IDS = /[?&]ids=([\d,]+)/;
const SIZE_FILTER = { filter_greater_dict: { size: 3 } };
const POINT_NAMES = ["at", "to", "via"];
const NO_ROOT_INDEX = -1;

const tableRow = (name: string, canWrite: boolean) => ({
  table_name: name,
  schema_type: "mark",
  schema_version: 1,
  description: "",
  voxel_resolution_x: 1,
  voxel_resolution_y: 1,
  voxel_resolution_z: 1,
  reference_table: "",
  access: { read: true, write: canWrite, manage: canWrite },
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const httpError = (status: number, message: string) =>
  HttpError.fromResponse(new Response(JSON.stringify({ message }), { status }));

interface FakeRow {
  id: bigint;
  /** The root of each of its points, in role order. */
  roots: bigint[];
  payload?: Record<string, unknown>;
}

const row = (id: bigint, ...pointRoots: bigint[]): FakeRow => ({
  id,
  roots: pointRoots,
});

/** Undefined `root` is a whole-table read. */
type RowsOf = (
  root: bigint | undefined,
  table: string,
  filter: Record<string, unknown>,
) => FakeRow[];

type Endpoint = "count" | "points";
type HeldRead = Endpoint | "rows";

interface FakeRequest {
  endpoint: Endpoint;
  /** The root, or the table of a whole-table read. */
  scope: bigint | string;
  tables: string[];
}

function pointsJson(rows: FakeRow[]) {
  const rowRoots = [...new Set(rows.flatMap(({ roots }) => roots))];
  const columns = Math.max(0, ...rows.map(({ roots }) => roots.length));
  return {
    ids: rows.map(({ id }) => String(id)),
    values: rows.map(() => 0),
    roots: rowRoots.map(String),
    points: POINT_NAMES.slice(0, columns).map((name, column) => ({
      name,
      positions: rows.flatMap(() => [1, 2, 3]),
      root_index: rows.map(({ roots }) =>
        roots[column] === undefined
          ? NO_ROOT_INDEX
          : rowRoots.indexOf(roots[column]),
      ),
    })),
  };
}

const rowJson = ({ id, roots, payload = {} }: FakeRow) => ({
  id: String(id),
  value: 0,
  payload,
  schema_version: 1,
  points: Object.fromEntries(
    roots.map((root, role) => [
      POINT_NAMES[role],
      { position: [1, 2, 3], piece_id: "1", root_id: String(root) },
    ]),
  ),
});

/** A graph whose tables answer one row per root, except those it lacks. */
function fakeGraph(
  listed: string[],
  options: {
    lacking?: string[];
    /** Endpoints this server predates: they answer the router's plain 404. */
    lackingEndpoints?: Endpoint[];
    rows?: RowsOf;
    /** Overrides the row count a count request answers. */
    countOf?: (root: bigint | undefined, table: string) => number | undefined;
    canWrite?: boolean;
  } = {},
) {
  const {
    lacking = [],
    lackingEndpoints = [],
    rows: rowsOf = (root) => (root === undefined ? [] : [row(root, root)]),
    countOf = () => undefined,
    canWrite = false,
  } = options;
  const requests: FakeRequest[] = [];
  const bodies: Record<string, unknown>[] = [];
  const held: (() => void)[] = [];
  const deleted = new Set<bigint>();
  const answeredRows = new Map<string, FakeRow>();
  const deletes: { table: string; ids: string[] }[] = [];
  const liveRows: RowsOf = (root, table, filter) =>
    rowsOf(root, table, filter).filter(({ id }) => !deleted.has(id));
  const answer = (
    endpoint: Endpoint,
    root: bigint | undefined,
    table: string,
    filter: Record<string, unknown>,
  ) => {
    const tableRows = liveRows(root, table, filter);
    for (const answered of tableRows) {
      answeredRows.set(String(answered.id), answered);
    }
    return endpoint === "count"
      ? { count: countOf(root, table) ?? tableRows.length }
      : pointsJson(tableRows);
  };
  const graph = {
    requests,
    bodies,
    held,
    deletes,
    hold: (_read: HeldRead, _scope: bigint | string) => false,
    failRows: false,
    failPoints: false,
    failDelete: false,
    fetchOkImpl: vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/annotation/tables")) {
        return jsonResponse({
          tables: listed.map((name) => tableRow(name, canWrite)),
        });
      }
      if (url.includes("/annotation/schemas/")) {
        return jsonResponse({
          points: POINT_NAMES.map((name, role) => ({ name, role })),
        });
      }
      const segment = SEGMENT_URL.exec(url);
      const [, tableName, tableEndpoint] = TABLE_URL.exec(url) ?? [];
      if (tableEndpoint === "annotations") {
        return init?.method === "DELETE"
          ? deleteRows(tableName, JSON.parse(String(init.body)).ids)
          : readRows(tableName, url);
      }
      const endpoint = (segment?.[2] ?? tableEndpoint) as Endpoint;
      if (lackingEndpoints.includes(endpoint)) {
        throw HttpError.fromResponse(
          new Response(ROUTER_NOT_FOUND_BODY, { status: HTTP_NOT_FOUND }),
        );
      }
      const root = segment === null ? undefined : BigInt(segment[1]);
      const body = JSON.parse(String(init?.body));
      const filters: Record<string, Record<string, unknown>> = root ===
      undefined
        ? { [tableName]: body }
        : body.tables;
      const tables = Object.keys(filters);
      requests.push({ endpoint, scope: root ?? tableName, tables });
      bodies.push(filters);
      const missing = tables.find((table) => lacking.includes(table));
      const answers = Object.fromEntries(
        tables.map((table) => [
          table,
          answer(endpoint, root, table, filters[table]),
        ]),
      );
      if (graph.hold(endpoint, root ?? tableName)) {
        await new Promise<void>((done) => held.push(done));
      }
      if (endpoint === "points" && graph.failPoints) {
        throw httpError(HTTP_SERVER_ERROR, "boom");
      }
      if (missing !== undefined) {
        throw httpError(
          HTTP_NOT_FOUND,
          `annotation table "${missing}" not found`,
        );
      }
      return jsonResponse(
        root === undefined
          ? answers[tableName]
          : { root_id: String(root), tables: answers },
      );
    }),
  };
  const readRows = async (table: string, url: string) => {
    const found = ROW_IDS.exec(url)![1]
      .split(",")
      .flatMap((id) => answeredRows.get(id) ?? []);
    if (graph.hold("rows", table)) {
      await new Promise<void>((done) => held.push(done));
    }
    if (graph.failRows) throw httpError(HTTP_SERVER_ERROR, "boom");
    return jsonResponse({ annotations: found.map(rowJson) });
  };
  const deleteRows = (table: string, ids: string[]) => {
    deletes.push({ table, ids });
    if (graph.failDelete) throw new Error("delete refused");
    for (const id of ids) deleted.add(BigInt(id));
    return jsonResponse({});
  };
  return graph;
}

const identityTransform = () =>
  new WatchableCoordinateSpaceTransform(
    makeIdentityTransform(
      makeCoordinateSpace({
        names: ["x", "y", "z"],
        units: ["m", "m", "m"],
        scales: Float64Array.of(1, 1, 1),
      }),
    ),
  );

function startSession(
  graph: ReturnType<typeof fakeGraph>,
  options: {
    ticked: string[];
    visible: bigint[];
    timestamp?: number;
    filters?: Record<string, AnnotationTableFilter>;
    wholeTables?: string[];
    excluded?: bigint[];
  },
) {
  const visibleSegments = new Uint64Set();
  visibleSegments.add(options.visible);
  const sources = new Map<string, CalcadaTableAnnotationSource>();
  const drawn = {
    get: (table: string) => {
      const source = sources.get(table);
      return source === undefined ? undefined : [...source];
    },
  };
  const layerStates = new Map<string, AnnotationLayerState>();
  const graphEdited = new Signal<
    (oldRoots: Iterable<bigint>, newRoots: Iterable<bigint>) => void
  >();
  const selectAnnotation = vi.fn();
  const moveToAnnotation = vi.fn();
  const makeListElement = vi.fn();
  const renderListHeader = vi.fn();
  const selectedAnnotation = new WatchableValue<
    SelectedListAnnotation | undefined
  >(undefined);
  const connection: AnnotationTablesConnection = {
    httpSource: {
      fetchOkImpl: graph.fetchOkImpl,
      baseUrl: "https://host/g",
    } as unknown as AnnotationTablesConnection["httpSource"],
    branchId: new WatchableValue(0),
    timestamp: new WatchableValue<number | undefined>(options.timestamp),
    visibleSegments,
    graphEdited,
    nanometresToSource: (nanometres) => Float32Array.from(nanometres),
    makeAnnotationState: (
      subsubsourceId,
      _color,
      properties,
      sourceOptions,
    ) => {
      const table = subsubsourceId.split(":")[1];
      const source = new CalcadaTableAnnotationSource(
        identityTransform(),
        new WatchableValue(properties),
        ["associated segments"],
        sourceOptions,
      );
      sources.set(table, source);
      const layerState = {
        source,
        displayState: { color: new WatchableValue(vec3.create()) },
      } as unknown as AnnotationLayerState;
      layerStates.set(table, layerState);
      return { layerState, source };
    },
    selectAnnotation,
    moveToAnnotation,
    makeListElement,
    renderListHeader,
    selectedAnnotation,
    listCoordinatesChanged: new Signal(),
    clearHover: vi.fn(),
    scheduleFrame: (callback) => frames.push(callback),
  };
  const state = new CalcadaAnnotationTablesState();
  state.setTicked(options.ticked);
  for (const [table, filter] of Object.entries(options.filters ?? {})) {
    state.setFilter(table, filter);
  }
  for (const table of options.wholeTables ?? []) {
    state.setWholeTable(table, true);
  }
  state.excludedSegments.add(options.excluded ?? []);
  const session = new CalcadaAnnotationTablesSession(connection, state);
  const statusOf = (table: string) =>
    session.status.value.find((status) => status.table === table);
  const drawnIds = (table: string) =>
    session.drawn.value
      .filter((item) => item.table === table)
      .map((item) => item.id);
  return {
    session,
    state,
    connection,
    drawn,
    sources,
    drawnIds,
    layerStates,
    selectAnnotation,
    moveToAnnotation,
    makeListElement,
    renderListHeader,
    selectedAnnotation,
    visibleSegments,
    graphEdited,
    statusOf,
  };
}

const frames: (() => void)[] = [];
const drawFrames = () => {
  for (const frame of frames.splice(0)) frame();
};
const settle = async () => {
  await vi.advanceTimersByTimeAsync(VISIBLE_SEGMENTS_DEBOUNCE_MS);
  drawFrames();
};
const requested = (graph: ReturnType<typeof fakeGraph>, endpoint: Endpoint) =>
  graph.requests.filter((request) => request.endpoint === endpoint);

describe("CalcadaAnnotationTablesSession", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    frames.length = 0;
  });

  it("draws everything when the sum is within the limit", async () => {
    const graph = fakeGraph(["syn", "mark"]);
    const { session, drawnIds } = startSession(graph, {
      ticked: ["syn", "mark"],
      visible: [10n, 20n],
    });
    await settle();
    expect(requested(graph, "count")).toEqual([
      { endpoint: "count", scope: 10n, tables: ["syn", "mark"] },
      { endpoint: "count", scope: 20n, tables: ["syn", "mark"] },
    ]);
    expect(requested(graph, "points")).toEqual([
      { endpoint: "points", scope: 10n, tables: ["syn", "mark"] },
      { endpoint: "points", scope: 20n, tables: ["syn", "mark"] },
    ]);
    expect(drawnIds("syn")).toEqual([10n, 20n]);
    expect(drawnIds("mark")).toEqual([10n, 20n]);
    expect(session.limitNote.value).toBeUndefined();
  });

  it("draws nothing and sets limitNote when the sum is one over the limit", async () => {
    const counts: Record<string, number> = { syn: 600_000, mark: 400_001 };
    const graph = fakeGraph(["syn", "mark"], {
      countOf: (_root, table) => counts[table],
    });
    const { session, state, drawn, drawnIds } = startSession(graph, {
      ticked: ["syn", "mark"],
      visible: [10n],
    });
    await settle();
    expect(session.limitNote.value).toBe(
      "More than 1 000 000 annotations in the selected tables (syn: 600 000, mark: 400 001). Add a filter or deselect a table.",
    );
    expect(requested(graph, "points")).toEqual([]);
    expect(session.drawn.value).toEqual([]);
    expect(drawn.get("syn")).toEqual([]);
    expect(drawn.get("mark")).toEqual([]);
    expect(session.totals.value.byTable).toEqual(
      new Map([
        ["syn", 600_000],
        ["mark", 400_001],
      ]),
    );
    state.untick("mark");
    await settle();
    expect(session.limitNote.value).toBeUndefined();
    expect(drawnIds("syn")).toEqual([10n]);
    counts.mark = MAX_DRAWN_ANNOTATIONS;
    state.setTicked(["syn", "mark"]);
    await settle();
    expect(session.limitNote.value).toContain("(syn: 1, mark: 1 000 000)");
    expect(drawn.get("syn")).toEqual([]);
  });

  it("exactly the limit is drawn", async () => {
    const counts: Record<string, number> = { syn: 600_000, mark: 400_000 };
    const graph = fakeGraph(["syn", "mark"], {
      countOf: (_root, table) => counts[table],
    });
    const { session, drawnIds } = startSession(graph, {
      ticked: ["syn", "mark"],
      visible: [10n],
    });
    await settle();
    expect(session.limitNote.value).toBeUndefined();
    expect(requested(graph, "points")).toHaveLength(1);
    expect(drawnIds("syn")).toEqual([10n]);
    expect(drawnIds("mark")).toEqual([10n]);
  });

  it("excluded segments are not fetched", async () => {
    const graph = fakeGraph(["syn"]);
    const { state, drawnIds } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n, 20n],
      excluded: [20n],
    });
    await settle();
    expect(graph.requests.map(({ scope }) => scope)).toEqual([10n, 10n]);
    expect(drawnIds("syn")).toEqual([10n]);
    state.excludedSegments.add(10n);
    await settle();
    expect(drawnIds("syn")).toEqual([]);
    graph.requests.length = 0;
    state.excludedSegments.delete(20n);
    await settle();
    expect(graph.requests.map(({ scope }) => scope)).toEqual([20n, 20n]);
    expect(drawnIds("syn")).toEqual([20n]);
  });

  it("whole-table tables ignore visible segments and exclusions but count toward the limit", async () => {
    const graph = fakeGraph(["syn", "whole"], {
      rows: (root, table) =>
        table === "whole"
          ? [row(1n, 77n), row(2n, 88n)]
          : root === undefined
            ? []
            : [row(root, root)],
      countOf: (_root, table) =>
        table === "syn" ? MAX_DRAWN_ANNOTATIONS : undefined,
    });
    const { session, state, drawn, drawnIds } = startSession(graph, {
      ticked: ["whole"],
      wholeTables: ["whole"],
      visible: [10n],
      excluded: [77n],
    });
    await settle();
    expect(graph.requests).toEqual([
      { endpoint: "count", scope: "whole", tables: ["whole"] },
      { endpoint: "points", scope: "whole", tables: ["whole"] },
    ]);
    expect(graph.bodies.at(-1)).toEqual({ whole: {} });
    expect(drawnIds("whole")).toEqual([1n, 2n]);
    expect(drawn.get("whole")!.map((a) => a.relatedSegments)).toEqual([
      [BigUint64Array.of(77n)],
      [BigUint64Array.of(88n)],
    ]);
    graph.requests.length = 0;
    state.setTicked(["whole", "syn"]);
    await settle();
    expect(requested(graph, "count")).toEqual([
      { endpoint: "count", scope: 10n, tables: ["syn"] },
    ]);
    expect(requested(graph, "points")).toEqual([]);
    expect(session.limitNote.value).toContain("(whole: 2, syn: 1 000 000)");
    expect(session.drawn.value).toEqual([]);
  });

  it("delete drops the row from every scope and a points answer sent before the delete is dropped", async () => {
    const SHARED_ID = 5n;
    const graph = fakeGraph(["syn"], {
      canWrite: true,
      rows: (root) =>
        root === undefined ? [] : [row(SHARED_ID, root), row(root, root)],
    });
    const { statusOf, sources, drawnIds, visibleSegments } = startSession(
      graph,
      { ticked: ["syn"], visible: [10n] },
    );
    await settle();
    expect(drawnIds("syn")).toEqual([SHARED_ID, 10n]);
    graph.hold = (read) => read === "points";
    visibleSegments.add(20n);
    await settle();
    expect(graph.held).toHaveLength(1);
    const source = sources.get("syn")!;
    expect(source.readonly).toBe(false);
    const reference = source.getReference(`syn:${SHARED_ID}`);
    await source.delete(reference);
    reference.dispose();
    expect(graph.deletes).toEqual([{ table: "syn", ids: [String(SHARED_ID)] }]);
    expect(source.get(`syn:${SHARED_ID}`)).toBeUndefined();
    graph.hold = () => false;
    for (const release of graph.held.splice(0)) release();
    await settle();
    await settle();
    expect(drawnIds("syn")).toEqual([10n, 20n]);
    expect(statusOf("syn")?.error).toBeUndefined();
  });

  it("a delete sends no count or points request and the other rows stay drawn throughout", async () => {
    const SHARED_ID = 5n;
    const graph = fakeGraph(["syn"], {
      canWrite: true,
      rows: (root) =>
        root === undefined ? [] : [row(SHARED_ID, root), row(root, root)],
    });
    const { session, statusOf, sources, drawnIds } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n, 20n],
    });
    await settle();
    expect(drawnIds("syn")).toEqual([SHARED_ID, 10n, 20n]);
    graph.requests.length = 0;
    const source = sources.get("syn")!;
    const others = () =>
      [source.get("syn:10"), source.get("syn:20")].every(
        (annotation) => annotation !== undefined,
      );
    const reference = source.getReference(`syn:${SHARED_ID}`);
    const deleting = source.delete(reference);
    expect(others()).toBe(true);
    await deleting;
    reference.dispose();
    expect(others()).toBe(true);
    await settle();
    expect(others()).toBe(true);
    expect(graph.requests).toEqual([]);
    expect(drawnIds("syn")).toEqual([10n, 20n]);
    expect(statusOf("syn")).toMatchObject({ annotations: 2 });
    expect(session.limitNote.value).toBeUndefined();
  });

  it("a scope's received rows replace its count, so the limit is checked again", async () => {
    const graph = fakeGraph(["syn", "whole"], {
      rows: (root, table) =>
        table === "whole"
          ? [row(1n, 1n)]
          : root === undefined
            ? []
            : [row(root, root), row(root + 1n, root)],
      countOf: (_root, table) =>
        table === "whole" ? MAX_DRAWN_ANNOTATIONS - 1 : 1,
    });
    graph.hold = (read, scope) => read === "points" && scope === "whole";
    const { session, drawnIds } = startSession(graph, {
      ticked: ["syn", "whole"],
      wholeTables: ["whole"],
      visible: [10n],
    });
    await settle();
    expect(requested(graph, "points")).toHaveLength(2);
    expect(session.limitNote.value).toContain("(syn: 2, whole: 999 999)");
    expect(drawnIds("syn")).toEqual([]);
  });

  it("a refused delete keeps the annotation and shows the table's error", async () => {
    const graph = fakeGraph(["syn"], { canWrite: true });
    const { sources, statusOf } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n],
    });
    await settle();
    graph.failDelete = true;
    const source = sources.get("syn")!;
    const reference = source.getReference("syn:10");
    await expect(source.delete(reference)).rejects.toThrow();
    reference.dispose();
    expect(source.get("syn:10")).toBeDefined();
    expect(statusOf("syn")?.error).toContain("delete refused");
  });

  it("delete is readonly at an explicit timestamp", async () => {
    const graph = fakeGraph(["syn", "mine"], { canWrite: true });
    const { connection, sources } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n],
      timestamp: EXPLICIT_TIMESTAMP_MS,
    });
    await settle();
    expect(sources.get("syn")!.readonly).toBe(true);
    (connection.timestamp as WatchableValue<number | undefined>).value =
      undefined;
    await settle();
    expect(sources.get("syn")!.readonly).toBe(false);
    const readOnlyGraph = fakeGraph(["syn"]);
    const live = startSession(readOnlyGraph, {
      ticked: ["syn"],
      visible: [10n],
    });
    await settle();
    expect(live.sources.get("syn")!.readonly).toBe(true);
  });

  it("select fills description from the fetched row and still selects when the fetch fails", async () => {
    const graph = fakeGraph(["syn"], {
      rows: (root) =>
        root === undefined
          ? []
          : [{ id: root, roots: [root], payload: { tag: "soma", size: 3 } }],
    });
    const { session, sources, selectAnnotation, visibleSegments } =
      startSession(graph, { ticked: ["syn"], visible: [10n] });
    await settle();
    const [item] = session.drawn.value;
    session.select(item);
    expect(selectAnnotation).toHaveBeenCalledTimes(1);
    await settle();
    const description = "tag: soma\nsize: 3\nid: 10";
    expect(sources.get("syn")!.get("syn:10")?.description).toBe(description);
    visibleSegments.add(20n);
    await settle();
    expect(sources.get("syn")!.get("syn:10")?.description).toBe(description);
    graph.failRows = true;
    selectAnnotation.mockClear();
    const other = session.drawn.value.find(({ id }) => id === 20n)!;
    session.select(other);
    await settle();
    expect(selectAnnotation).toHaveBeenCalledTimes(1);
    expect(sources.get("syn")!.get("syn:20")?.description).toBeUndefined();
  });

  it("makes the list entry from the item's annotation state, none once unticked", async () => {
    const graph = fakeGraph(["syn"]);
    const { session, state, sources, layerStates, makeListElement } =
      startSession(graph, { ticked: ["syn"], visible: [10n] });
    await settle();
    const [item] = session.drawn.value;
    const entry = [{} as HTMLElement, [1]];
    makeListElement.mockReturnValue(entry);
    expect(session.makeListElement(item)).toBe(entry);
    expect(makeListElement).toHaveBeenCalledExactlyOnceWith(
      layerStates.get("syn"),
      sources.get("syn")!.get(item.layerId),
    );
    state.setTicked([]);
    expect(session.makeListElement(item)).toBeUndefined();
  });

  it("renders the list header from the item's annotation state, none once unticked", async () => {
    const graph = fakeGraph(["syn"]);
    const { session, state, layerStates, renderListHeader } = startSession(
      graph,
      { ticked: ["syn"], visible: [10n] },
    );
    await settle();
    const [item] = session.drawn.value;
    const header = {} as HTMLElement;
    const columnWidths = {} as AnnotationListColumnWidths;
    expect(session.renderListHeader(item, header, columnWidths)).toBe(true);
    expect(renderListHeader).toHaveBeenCalledExactlyOnceWith(
      layerStates.get("syn"),
      header,
      columnWidths,
    );
    state.setTicked([]);
    expect(session.renderListHeader(item, header, columnWidths)).toBe(false);
  });

  it("knows the selected item and says when its entry gets the details", async () => {
    const graph = fakeGraph(["syn"], {
      rows: (root) =>
        root === undefined ? [] : [{ id: root, roots: [root], payload: {} }],
    });
    const { session, layerStates, selectedAnnotation } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n, 20n],
    });
    await settle();
    const [first, second] = session.drawn.value;
    selectedAnnotation.value = {
      annotationId: first.layerId,
      annotationLayerState: layerStates.get("syn")!,
    };
    expect(session.isSelected(first)).toBe(true);
    expect(session.isSelected(second)).toBe(false);
    const updated = vi.fn();
    session.annotationUpdated.add(updated);
    session.select(second);
    await settle();
    expect(updated).toHaveBeenCalledWith("syn", second.layerId);
  });

  it("keeps only the details of the latest select", async () => {
    const graph = fakeGraph(["syn"], {
      rows: (root) =>
        root === undefined
          ? []
          : [{ id: root, roots: [root], payload: { root: String(root) } }],
    });
    const { session, sources } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n, 20n],
    });
    await settle();
    graph.hold = (read) => read === "rows";
    const [first, second] = session.drawn.value;
    session.select(first);
    session.select(second);
    await settle();
    expect(graph.held).toHaveLength(2);
    graph.held[1]();
    await settle();
    graph.held[0]();
    await settle();
    const source = sources.get("syn")!;
    expect(source.get("syn:20")?.description).toBe("root: 20\nid: 20");
    expect(source.get("syn:10")?.description).toBeUndefined();
  });

  it("keeps a table missing at an explicit timestamp ticked and notes it", async () => {
    const graph = fakeGraph(["syn", "late"], { lacking: ["late"] });
    const { state, drawn, statusOf } = startSession(graph, {
      ticked: ["syn", "late"],
      visible: [10n],
      timestamp: EXPLICIT_TIMESTAMP_MS,
    });
    await settle();
    expect(state.ticked).toEqual(["syn", "late"]);
    expect(drawn.get("late")).toEqual([]);
    expect(drawn.get("syn")).toHaveLength(1);
    expect(statusOf("late")).toMatchObject({
      note: TABLE_ABSENT_AT_TIMESTAMP_NOTE,
    });
    expect(statusOf("late")?.error).toBeUndefined();
  });

  it("unticks a table missing from the live graph", async () => {
    const graph = fakeGraph(["syn", "late"], { lacking: ["late"] });
    const { state, statusOf } = startSession(graph, {
      ticked: ["syn", "late"],
      visible: [10n],
    });
    await settle();
    expect(state.ticked).toEqual(["syn"]);
    expect(statusOf("late")?.error).toBe("Annotation table late not found");
  });

  it("keeps the ticks and shows the failure when the server lacks the points route", async () => {
    const graph = fakeGraph(["syn", "mark"], { lackingEndpoints: ["points"] });
    const { state, drawn, statusOf } = startSession(graph, {
      ticked: ["syn", "mark"],
      visible: [10n],
    });
    await settle();
    expect(requested(graph, "points")).toHaveLength(0);
    expect(state.ticked).toEqual(["syn", "mark"]);
    expect(drawn.get("syn")).toEqual([]);
    expect(statusOf("syn")?.error).toBeDefined();
    expect(statusOf("mark")?.error).toBeDefined();
  });

  it("keeps a ticked table missing from the list while the timestamp is explicit", async () => {
    const graph = fakeGraph(["syn"]);
    const { state, statusOf } = startSession(graph, {
      ticked: ["syn", "deleted"],
      visible: [10n],
      timestamp: EXPLICIT_TIMESTAMP_MS,
    });
    await settle();
    expect(state.ticked).toEqual(["syn", "deleted"]);
    expect(statusOf("deleted")).toMatchObject({ note: TABLE_UNLISTED_NOTE });
  });

  it("unticks a ticked table missing from the list when live", async () => {
    const graph = fakeGraph(["syn"]);
    const { state } = startSession(graph, {
      ticked: ["syn", "deleted"],
      visible: [10n],
    });
    await settle();
    expect(state.ticked).toEqual(["syn"]);
  });

  it("after an edit keeps the other roots drawn and fetches only the new root", async () => {
    const graph = fakeGraph(["syn"]);
    const { drawn, visibleSegments, graphEdited } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n, 20n],
    });
    await settle();
    expect(drawn.get("syn")).toHaveLength(2);
    graph.requests.length = 0;
    graphEdited.dispatch([10n], [30n]);
    drawFrames();
    expect(drawn.get("syn")).toHaveLength(1);
    visibleSegments.delete(10n);
    visibleSegments.add(30n);
    await settle();
    expect(graph.requests).toEqual([
      { endpoint: "count", scope: 30n, tables: ["syn"] },
      { endpoint: "points", scope: 30n, tables: ["syn"] },
    ]);
    expect(drawn.get("syn")).toHaveLength(2);
  });

  it("refetches a root an undo brought back under the same id", async () => {
    const graph = fakeGraph(["syn"]);
    const { graphEdited } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n],
    });
    await settle();
    graph.requests.length = 0;
    graphEdited.dispatch([], [10n]);
    await settle();
    expect(graph.requests.map(({ scope }) => scope)).toEqual([10n, 10n]);
  });

  it("keeps the roots note in step with the visible set", async () => {
    const graph = fakeGraph(["syn"]);
    const extra = 5;
    const { session, visibleSegments } = startSession(graph, {
      ticked: ["syn"],
      visible: roots(MAX_ANNOTATION_ROOTS + 2 * extra),
    });
    await settle();
    expect(session.rootsNote.value).toBe(
      visibleRootsNote(MAX_ANNOTATION_ROOTS + 2 * extra),
    );
    visibleSegments.delete(roots(MAX_ANNOTATION_ROOTS + extra).slice(-extra));
    await settle();
    expect(session.rootsNote.value).toBe(
      visibleRootsNote(MAX_ANNOTATION_ROOTS + extra),
    );
  });

  it("posts each table's filter to counts and points", async () => {
    const graph = fakeGraph(["syn", "mark"]);
    startSession(graph, {
      ticked: ["syn", "mark"],
      visible: [10n],
      filters: { syn: SIZE_FILTER },
    });
    await settle();
    expect(graph.bodies).toEqual([
      { syn: SIZE_FILTER, mark: {} },
      { syn: SIZE_FILTER, mark: {} },
    ]);
  });

  it("refetches only the refiltered table", async () => {
    const FILTERED_ID = 900n;
    const graph = fakeGraph(["syn", "mark"], {
      rows: (root, _table, filter) =>
        root === undefined
          ? []
          : [
              "filter_greater_dict" in filter
                ? row(FILTERED_ID, root)
                : row(root, root),
            ],
    });
    const { state, drawnIds } = startSession(graph, {
      ticked: ["syn", "mark"],
      visible: [10n],
    });
    await settle();
    graph.requests.length = 0;
    graph.bodies.length = 0;
    state.setFilter("syn", SIZE_FILTER);
    await settle();
    expect(graph.requests).toEqual([
      { endpoint: "count", scope: 10n, tables: ["syn"] },
      { endpoint: "points", scope: 10n, tables: ["syn"] },
    ]);
    expect(graph.bodies[0]).toEqual({ syn: SIZE_FILTER });
    expect(drawnIds("syn")).toEqual([FILTERED_ID]);
    expect(drawnIds("mark")).toEqual([10n]);
  });

  it("drops points that arrive after the branch changed", async () => {
    const graph = fakeGraph(["syn"]);
    const { connection, drawnIds } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n],
    });
    graph.hold = (read) => read === "points";
    await settle();
    (connection.branchId as WatchableValue<number>).value = 3;
    await settle();
    expect(graph.held).toHaveLength(2);
    graph.held[0]();
    await settle();
    expect(drawnIds("syn")).toEqual([]);
    graph.held[1]();
    await settle();
    expect(drawnIds("syn")).toEqual([10n]);
  });

  it("lists a row shared by two visible roots once, in selection then id order", async () => {
    const shared = row(7n, 10n, 20n);
    const graph = fakeGraph(["syn", "mark"], {
      rows: (root, table) =>
        root === undefined
          ? []
          : table === "syn"
            ? [shared, row(root, root)]
            : [row(root + 1n, root)],
    });
    const { session, drawn } = startSession(graph, {
      ticked: ["syn", "mark"],
      visible: [20n, 10n],
    });
    await settle();
    expect(session.drawn.value.map(({ table, id }) => [table, id])).toEqual([
      ["syn", 7n],
      ["syn", 10n],
      ["syn", 20n],
      ["mark", 11n],
      ["mark", 21n],
    ]);
    expect(drawn.get("syn")!.filter((a) => a.id === "syn:7")).toHaveLength(1);
    expect(session.drawn.value[0].layerId).toBe("syn:7");
  });

  it("selects or moves to a drawn annotation only while its table is selected", async () => {
    const graph = fakeGraph(["syn"]);
    const { session, state, layerStates, selectAnnotation, moveToAnnotation } =
      startSession(graph, { ticked: ["syn"], visible: [10n] });
    await settle();
    const [item] = session.drawn.value;
    const drawnItem = expect.objectContaining({ id: item.layerId });
    session.select(item);
    expect(selectAnnotation).toHaveBeenCalledWith(
      layerStates.get("syn"),
      drawnItem,
    );
    expect(moveToAnnotation).not.toHaveBeenCalled();
    selectAnnotation.mockClear();
    session.moveTo(item);
    expect(selectAnnotation).toHaveBeenCalledWith(
      layerStates.get("syn"),
      drawnItem,
    );
    expect(moveToAnnotation).toHaveBeenCalledWith(
      layerStates.get("syn"),
      drawnItem,
    );
    state.untick("syn");
    selectAnnotation.mockClear();
    moveToAnnotation.mockClear();
    session.select(item);
    session.moveTo(item);
    expect(selectAnnotation).not.toHaveBeenCalled();
    expect(moveToAnnotation).not.toHaveBeenCalled();
  });

  it("draws a burst of answers once per table", async () => {
    const graph = fakeGraph(["syn", "mark"]);
    graph.hold = (read) => read === "points";
    const { session, sources } = startSession(graph, {
      ticked: ["syn", "mark"],
      visible: [10n, 20n, 30n],
    });
    await settle();
    expect(graph.held).toHaveLength(3);
    const published = vi.fn();
    session.drawn.changed.add(published);
    const reordered = vi.fn();
    sources.get("syn")!.childrenReordered.add(reordered);
    graph.held.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(VISIBLE_SEGMENTS_DEBOUNCE_MS);
    expect(frames).toHaveLength(1);
    drawFrames();
    expect(published).toHaveBeenCalledTimes(1);
    expect(reordered).toHaveBeenCalledTimes(1);
    expect(session.drawn.value).toHaveLength(6);
  });

  it("redraws a table once, after the points of its last root arrive", async () => {
    const graph = fakeGraph(["syn"]);
    graph.hold = (read) => read === "points";
    const { sources, drawnIds } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n, 20n, 30n],
    });
    await settle();
    expect(graph.held).toHaveLength(3);
    const replaceAll = vi.spyOn(sources.get("syn")!, "replaceAll");
    for (const release of graph.held) {
      release();
      await settle();
    }
    expect(replaceAll).toHaveBeenCalledTimes(1);
    expect(drawnIds("syn")).toEqual([10n, 20n, 30n]);
  });

  it("redraws what arrived once the last missing root counts zero", async () => {
    const graph = fakeGraph(["syn"], {
      rows: (root) => (root === 10n ? [row(root, root)] : []),
    });
    graph.hold = (read, scope) =>
      (read === "points" && scope === 10n) ||
      (read === "count" && scope === 20n);
    const { drawnIds, visibleSegments } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n],
    });
    await settle();
    visibleSegments.add(20n);
    await settle();
    const [points, count] = graph.held;
    points();
    await settle();
    expect(drawnIds("syn")).toEqual([]);
    count();
    await settle();
    expect(drawnIds("syn")).toEqual([10n]);
  });

  it("redraws what arrived once the last missing root fails", async () => {
    const graph = fakeGraph(["syn"]);
    graph.hold = (read) => read === "points";
    const { sources, drawnIds, statusOf } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n, 20n, 30n],
    });
    await settle();
    const [first, second, last] = graph.held;
    const replaceAll = vi.spyOn(sources.get("syn")!, "replaceAll");
    first();
    second();
    await settle();
    expect(drawnIds("syn")).toEqual([]);
    graph.failPoints = true;
    last();
    await settle();
    expect(replaceAll).toHaveBeenCalledTimes(1);
    expect(drawnIds("syn")).toEqual([10n, 20n]);
    expect(statusOf("syn")?.error).toBeDefined();
  });

  it("counts rows, not drawn points, for rows of three points", async () => {
    const graph = fakeGraph(["syn"], {
      rows: (root) => (root === undefined ? [] : [row(root, root, root, root)]),
    });
    const { drawn, statusOf } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n],
    });
    await settle();
    expect(drawn.get("syn")).toHaveLength(3);
    expect(statusOf("syn")).toMatchObject({ annotations: 1, fetchedRoots: 1 });
  });
});
