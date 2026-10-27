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
import type { Annotation } from "#src/annotation/index.js";
import type { SegmentAnnotations } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import {
  AnnotationTableForbidden,
  AnnotationTableMissing,
  MAX_TABLES_PER_SEGMENT_REQUEST,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { AnnotationTablesConnection } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import {
  CalcadaAnnotationTablesSession,
  MAX_ANNOTATION_ROOTS,
  RootFailures,
  TABLE_ABSENT_AT_TIMESTAMP_NOTE,
  TABLE_UNLISTED_NOTE,
  VISIBLE_SEGMENTS_DEBOUNCE_MS,
  acceptAnnotationResponse,
  annotationCacheKey,
  annotationTableStatus,
  assignColorSlots,
  cachedAnnotationsByRoot,
  classifyAnnotationError,
  planAnnotationFetches,
  visibleAnnotationRoots,
  visibleRootsNote,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { CalcadaAnnotationTablesState } from "#src/datasource/calcada/annotation_tables/annotation_tables_state.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { vec3 } from "#src/util/geom.js";
import { HttpError } from "#src/util/http_request.js";
import { Signal } from "#src/util/signal.js";

const MAIN = { branchId: 0, timestamp: 0 };
const BRANCH = { branchId: 3, timestamp: 0 };

const roots = (count: number) =>
  Array.from({ length: count }, (_, i) => BigInt(i + 1));

const answer = (
  rootId: bigint,
  tables: Record<string, { rows?: number; truncated?: boolean }>,
): SegmentAnnotations => ({
  rootId,
  tables: new Map(
    Object.entries(tables).map(([name, { rows = 1, truncated = false }]) => [
      name,
      {
        annotations: Array.from({ length: rows }, (_, i) => ({
          id: BigInt(i),
          value: 0,
          payload: {},
          points: [],
        })),
        truncated,
      },
    ]),
  ),
});

const plan = (
  overrides: Partial<Parameters<typeof planAnnotationFetches>[0]> = {},
) =>
  planAnnotationFetches({
    visibleRoots: [10n],
    ticked: ["syn"],
    coords: MAIN,
    cache: new Map(),
    pending: new Map(),
    freeSlots: MAX_ANNOTATION_ROOTS,
    ...overrides,
  });

describe("planAnnotationFetches", () => {
  it("asks once per new visible root for every ticked table", () => {
    expect(plan({ visibleRoots: [10n, 20n], ticked: ["syn", "mark"] })).toEqual(
      {
        requests: [
          { key: "0|0|10", root: 10n, tables: ["syn", "mark"] },
          { key: "0|0|20", root: 20n, tables: ["syn", "mark"] },
        ],
        prune: [],
      },
    );
  });

  it("looks at no more than the first fifty visible roots", () => {
    const { requests } = plan({
      visibleRoots: roots(MAX_ANNOTATION_ROOTS + 7),
    });
    expect(requests).toHaveLength(MAX_ANNOTATION_ROOTS);
    expect(requests.at(-1)?.root).toBe(BigInt(MAX_ANNOTATION_ROOTS));
  });

  it("keeps held roots in the capped subset and fills it by ascending id", () => {
    const visible = roots(MAX_ANNOTATION_ROOTS + 10).reverse();
    const held = BigInt(MAX_ANNOTATION_ROOTS + 5);
    const shown = visibleAnnotationRoots(visible, (root) => root === held);
    expect(shown).toHaveLength(MAX_ANNOTATION_ROOTS);
    expect(shown[0]).toBe(held);
    expect(shown.slice(1)).toEqual(roots(MAX_ANNOTATION_ROOTS - 1));
  });

  it("does not drop a cached root when more roots become visible", () => {
    const cachedRoot = BigInt(MAX_ANNOTATION_ROOTS + 1);
    const cache = new Map([
      [annotationCacheKey(MAIN, cachedRoot), answer(cachedRoot, { syn: {} })],
    ]);
    const { requests, prune } = plan({
      cache,
      visibleRoots: roots(MAX_ANNOTATION_ROOTS + 1),
    });
    expect(prune).toEqual([]);
    expect(requests.map((request) => request.root)).toEqual(
      roots(MAX_ANNOTATION_ROOTS - 1),
    );
  });

  it("splits a root's tables into groups the server accepts", () => {
    const ticked = Array.from(
      { length: 2 * MAX_TABLES_PER_SEGMENT_REQUEST + 5 },
      (_, i) => `t${i}`,
    );
    const { requests } = plan({ ticked });
    expect(requests.map((request) => request.tables)).toEqual([
      ticked.slice(0, MAX_TABLES_PER_SEGMENT_REQUEST),
      ticked.slice(
        MAX_TABLES_PER_SEGMENT_REQUEST,
        2 * MAX_TABLES_PER_SEGMENT_REQUEST,
      ),
      ticked.slice(2 * MAX_TABLES_PER_SEGMENT_REQUEST),
    ]);
    expect(new Set(requests.map((request) => request.key))).toEqual(
      new Set(["0|0|10"]),
    );
    expect(plan({ ticked, freeSlots: 2 }).requests).toHaveLength(2);
  });

  it("sends no more requests than there are free slots", () => {
    expect(
      plan({ visibleRoots: roots(10), freeSlots: 4 }).requests,
    ).toHaveLength(4);
    expect(plan({ visibleRoots: roots(10), freeSlots: 0 }).requests).toEqual(
      [],
    );
  });

  it("fetches only a newly ticked table for roots already cached", () => {
    const cache = new Map([
      [annotationCacheKey(MAIN, 10n), answer(10n, { syn: {} })],
    ]);
    expect(plan({ cache, ticked: ["syn", "mark"] }).requests).toEqual([
      { key: "0|0|10", root: 10n, tables: ["mark"] },
    ]);
  });

  it("does not ask again for what is already on its way", () => {
    const pending = new Map([["0|0|10", new Set(["syn"])]]);
    expect(plan({ pending }).requests).toEqual([]);
  });

  it("asks for nothing with no table ticked", () => {
    expect(plan({ ticked: [] }).requests).toEqual([]);
  });

  it("prunes roots no longer visible and entries from another branch", () => {
    const cache = new Map([
      [annotationCacheKey(MAIN, 10n), answer(10n, { syn: {} })],
      [annotationCacheKey(MAIN, 20n), answer(20n, { syn: {} })],
      [annotationCacheKey(BRANCH, 10n), answer(10n, { syn: {} })],
    ]);
    expect(plan({ cache })).toEqual({
      requests: [],
      prune: ["0|0|20", "3|0|10"],
    });
  });

  it("keys the cache by branch, timestamp and root", () => {
    expect(annotationCacheKey({ branchId: 2, timestamp: 1500 }, 7n)).toBe(
      "2|1500|7",
    );
  });
});

describe("acceptAnnotationResponse", () => {
  const request = { key: "0|0|10", root: 10n, tables: ["syn", "mark"] };

  it("stores a current response and fills tables the server left out", () => {
    const cache = new Map<string, SegmentAnnotations>();
    expect(
      acceptAnnotationResponse(
        cache,
        { ...request, token: 4 },
        4,
        answer(10n, {
          syn: { rows: 2 },
        }),
      ),
    ).toBe(true);
    const stored = cache.get("0|0|10")!;
    expect(stored.tables.get("syn")?.annotations).toHaveLength(2);
    expect(stored.tables.get("mark")).toEqual({
      annotations: [],
      truncated: false,
    });
  });

  it("adds a newly fetched table to what the root already had", () => {
    const cache = new Map([["0|0|10", answer(10n, { syn: {} })]]);
    acceptAnnotationResponse(
      cache,
      { key: "0|0|10", root: 10n, tables: ["mark"], token: 1 },
      1,
      answer(10n, { mark: { rows: 3 } }),
    );
    const stored = cache.get("0|0|10")!;
    expect([...stored.tables.keys()]).toEqual(["syn", "mark"]);
  });

  it("drops a response sent before the branch, timestamp or ticks changed", () => {
    const cache = new Map<string, SegmentAnnotations>();
    expect(
      acceptAnnotationResponse(
        cache,
        { ...request, token: 4 },
        5,
        answer(10n, { syn: {} }),
      ),
    ).toBe(false);
    expect(cache.size).toBe(0);
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

describe("cachedAnnotationsByRoot", () => {
  it("serves the visible roots of the current coordinates only", () => {
    const cache = new Map([
      [annotationCacheKey(MAIN, 10n), answer(10n, { syn: {} })],
      [annotationCacheKey(MAIN, 20n), answer(20n, { syn: {} })],
      [annotationCacheKey(BRANCH, 30n), answer(30n, { syn: {} })],
    ]);
    expect([
      ...cachedAnnotationsByRoot(cache, MAIN, [10n, 30n, 40n]).keys(),
    ]).toEqual([10n]);
  });
});

describe("annotationTableStatus", () => {
  it("counts fetched and truncated roots for one table", () => {
    const byRoot = new Map([
      [10n, answer(10n, { syn: { truncated: true }, mark: {} })],
      [20n, answer(20n, { syn: {}, mark: { truncated: true } })],
      [30n, answer(30n, { mark: {} })],
    ]);
    expect(annotationTableStatus("syn", byRoot, 5, undefined)).toEqual({
      table: "syn",
      annotations: 5,
      fetchedRoots: 2,
      truncatedRoots: 1,
    });
    expect(annotationTableStatus("syn", new Map(), 0, "denied")).toEqual({
      table: "syn",
      annotations: 0,
      fetchedRoots: 0,
      truncatedRoots: 0,
      error: "denied",
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
const EXPLICIT_TIMESTAMP_MS = 1_500;
const SEGMENT_URL =
  /\/annotation\/segment\/(\d+)\/annotations\?.*tables=([^&]*)/;

const tableRow = (name: string) => ({
  table_name: name,
  schema_type: "mark",
  schema_version: 1,
  description: "",
  voxel_resolution_x: 1,
  voxel_resolution_y: 1,
  voxel_resolution_z: 1,
  reference_table: "",
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

/** A graph whose tables answer one point per root, except those it lacks. */
function fakeGraph(listed: string[], lacking: string[] = []) {
  const segmentRequests: { root: bigint; tables: string[] }[] = [];
  const fetchOkImpl = vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (url.endsWith("/annotation/tables")) {
      return jsonResponse({ tables: listed.map(tableRow) });
    }
    if (url.includes("/annotation/schemas/")) {
      return jsonResponse({ points: [{ name: "at", role: 0 }] });
    }
    const [, root, names] = SEGMENT_URL.exec(url)!;
    const tables = names.split(",");
    segmentRequests.push({ root: BigInt(root), tables });
    const missing = tables.find((table) => lacking.includes(table));
    if (missing !== undefined) {
      throw HttpError.fromResponse(
        new Response(
          JSON.stringify({
            message: `annotation table "${missing}" not found`,
          }),
          { status: HTTP_NOT_FOUND },
        ),
      );
    }
    return jsonResponse({
      root_id: root,
      tables: Object.fromEntries(
        tables.map((table) => [
          table,
          {
            annotations: [
              {
                id: root,
                value: 0,
                payload: {},
                schema_version: 1,
                points: {
                  at: { position: [1, 2, 3], piece_id: "1", root_id: root },
                },
              },
            ],
            truncated: false,
          },
        ]),
      ),
    });
  });
  return { fetchOkImpl, segmentRequests };
}

function startSession(
  graph: ReturnType<typeof fakeGraph>,
  options: { ticked: string[]; visible: bigint[]; timestamp?: number },
) {
  const visibleSegments = new Uint64Set();
  visibleSegments.add(options.visible);
  const drawn = new Map<string, Annotation[]>();
  const graphEdited = new Signal<
    (oldRoots: Iterable<bigint>, newRoots: Iterable<bigint>) => void
  >();
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
    makeAnnotationState: (subsubsourceId) => {
      const table = subsubsourceId.split(":")[1];
      drawn.set(table, []);
      return {
        source: {
          clear: () => drawn.set(table, []),
          add: (annotation: Annotation) => drawn.get(table)!.push(annotation),
        },
        displayState: { color: new WatchableValue(vec3.create()) },
      } as unknown as AnnotationLayerState;
    },
  };
  const state = new CalcadaAnnotationTablesState();
  state.setTicked(options.ticked);
  const session = new CalcadaAnnotationTablesSession(connection, state);
  const statusOf = (table: string) =>
    session.status.value.find((status) => status.table === table);
  return { session, state, drawn, visibleSegments, graphEdited, statusOf };
}

const settle = () => vi.advanceTimersByTimeAsync(VISIBLE_SEGMENTS_DEBOUNCE_MS);

describe("CalcadaAnnotationTablesSession", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a table missing at an explicit timestamp ticked and notes it", async () => {
    const graph = fakeGraph(["syn", "late"], ["late"]);
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
    const graph = fakeGraph(["syn", "late"], ["late"]);
    const { state, statusOf } = startSession(graph, {
      ticked: ["syn", "late"],
      visible: [10n],
    });
    await settle();
    expect(state.ticked).toEqual(["syn"]);
    expect(statusOf("late")?.error).toBe("Annotation table late not found");
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
    graph.segmentRequests.length = 0;
    graphEdited.dispatch([10n], [30n]);
    expect(drawn.get("syn")).toHaveLength(1);
    visibleSegments.delete(10n);
    visibleSegments.add(30n);
    await settle();
    expect(graph.segmentRequests).toEqual([{ root: 30n, tables: ["syn"] }]);
    expect(drawn.get("syn")).toHaveLength(2);
  });

  it("refetches a root an undo brought back under the same id", async () => {
    const graph = fakeGraph(["syn"]);
    const { graphEdited } = startSession(graph, {
      ticked: ["syn"],
      visible: [10n],
    });
    await settle();
    graph.segmentRequests.length = 0;
    graphEdited.dispatch([], [10n]);
    await settle();
    expect(graph.segmentRequests).toEqual([{ root: 10n, tables: ["syn"] }]);
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
});
