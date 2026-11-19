/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";
import {
  bufferOwnersFromHeapSnapshot,
  type HeapSnapshotJson,
} from "#tests/editing/harness/heap_buffer_owners.js";

const MB = 1024 * 1024;

/**
 * A tiny V8-shaped snapshot. Nodes are named; edges are
 * `[from, name, to, type?]` (type defaults to "property").
 */
function snapshotOf(
  nodeSpecs: ReadonlyArray<{ name: string; size?: number }>,
  edgeSpecs: ReadonlyArray<readonly [number, string | number, number, string?]>,
): HeapSnapshotJson {
  const strings: string[] = [];
  const stringId = (text: string) => {
    const existing = strings.indexOf(text);
    if (existing >= 0) return existing;
    strings.push(text);
    return strings.length - 1;
  };
  const edgeTypes = [
    "context",
    "element",
    "property",
    "internal",
    "hidden",
    "shortcut",
    "weak",
  ];
  const nodes: number[] = [];
  const edges: number[] = [];
  nodeSpecs.forEach((spec, index) => {
    const outgoing = edgeSpecs.filter(([from]) => from === index);
    nodes.push(
      0,
      stringId(spec.name),
      index + 1,
      spec.size ?? 0,
      outgoing.length,
    );
    for (const [, name, to, type = "property"] of outgoing) {
      const nameOrIndex =
        type === "element" || type === "hidden"
          ? Number(name)
          : stringId(String(name));
      edges.push(edgeTypes.indexOf(type), nameOrIndex, to * 5);
    }
  });
  return {
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["object"]],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [edgeTypes],
      },
    },
    nodes,
    edges,
    strings,
  };
}

const RULES = [
  { label: "mirror", match: ["host", "perLayer", "patchStore"] },
  { label: "history", match: ["host", "activeSession", "historyJournal"] },
  { label: "session", match: ["host", "activeSession"] },
];

describe("bufferOwnersFromHeapSnapshot", () => {
  it("charges each backing store to the first rule its path matches", () => {
    const heap = snapshotOf(
      [
        { name: "(root)" }, // 0
        { name: "Viewer" }, // 1
        { name: "Host" }, // 2
        { name: "Map" }, // 3
        { name: "Entry" }, // 4
        { name: "ArrayBuffer" }, // 5
        { name: "store", size: 128 * MB }, // 6
        { name: "Session" }, // 7
        { name: "Journal" }, // 8
        { name: "Context" }, // 9 — a closure's context
        { name: "ArrayBuffer" }, // 10
        { name: "store", size: 64 * MB }, // 11
        { name: "ArrayBuffer" }, // 12
        { name: "store", size: 32 * MB }, // 13
      ],
      [
        [0, "viewer", 1],
        [1, "host", 2],
        [2, "perLayer", 3],
        [3, 0, 4, "element"],
        [4, "patchStore", 5],
        [5, "backing_store", 6, "internal"],
        [2, "activeSession", 7],
        [7, "historyJournal", 8],
        [8, "retain", 9],
        [9, "buffer", 10, "context"],
        [10, "backing_store", 11, "internal"],
        [7, "slot", 12],
        [12, "backing_store", 13, "internal"],
      ],
    );
    const census = bufferOwnersFromHeapSnapshot(heap, RULES);
    expect(census.owners).toEqual({
      mirror: { bytes: 128 * MB, buffers: 1 },
      history: { bytes: 64 * MB, buffers: 1 },
      session: { bytes: 32 * MB, buffers: 1 },
    });
    expect(census.unmatched).toEqual({});
    expect(census.totalBytes).toBe(224 * MB);
  });

  it("reports a buffer no rule matches under its retaining path", () => {
    const heap = snapshotOf(
      [
        { name: "(root)" },
        { name: "Host" },
        { name: "Closure" },
        { name: "ArrayBuffer" },
        { name: "store", size: 2 * MB },
      ],
      [
        [0, "host", 1],
        [1, "detachWatch", 2],
        [2, "e", 3, "context"],
        [3, "backing_store", 4, "internal"],
      ],
    );
    expect(bufferOwnersFromHeapSnapshot(heap, RULES).unmatched).toEqual({
      "host.detachWatch.e.backing_store": { bytes: 2 * MB, buffers: 1 },
    });
  });

  it("splits an owner by the edge after its match when asked", () => {
    const heap = snapshotOf(
      [
        { name: "(root)" },
        { name: "Host" },
        { name: "Closure" },
        { name: "ArrayBuffer" },
        { name: "store", size: 2 * MB },
      ],
      [
        [0, "host", 1],
        [1, "detachWatch", 2],
        [2, "e", 3, "context"],
        [3, "backing_store", 4, "internal"],
      ],
    );
    const census = bufferOwnersFromHeapSnapshot(heap, [
      { label: "host", match: ["host"], splitByNextEdge: true },
    ]);
    expect(census.owners).toEqual({
      "host.detachWatch": { bytes: 2 * MB, buffers: 1 },
    });
  });

  it("counts reachable objects that have all the given edges", () => {
    const heap = snapshotOf(
      [
        { name: "(root)" }, // 0
        { name: "Host" }, // 1
        { name: "Session" }, // 2 — reachable
        { name: "Session" }, // 3 — only through a weak edge
        { name: "Session" }, // 4 — unreachable
        { name: "Half" }, // 5 — has only one of the edges
        { name: "Overlay" }, // 6
        { name: "Journal" }, // 7
      ],
      [
        [0, "host", 1],
        [1, "activeSession", 2],
        [1, "cache", 3, "weak"],
        [1, "half", 5],
        [2, "overlay", 6],
        [2, "historyJournal", 7],
        [3, "overlay", 6],
        [3, "historyJournal", 7],
        [4, "overlay", 6],
        [4, "historyJournal", 7],
        [5, "overlay", 6],
      ],
    );
    expect(
      bufferOwnersFromHeapSnapshot(heap, [], 1, ["overlay", "historyJournal"])
        .objectsWithEdges,
    ).toBe(1);
    expect(bufferOwnersFromHeapSnapshot(heap, []).objectsWithEdges).toBe(0);
  });

  it("uses the shortest path, ignores weak edges and stores below minBytes", () => {
    const heap = snapshotOf(
      [
        { name: "(root)" }, // 0
        { name: "Host" }, // 1
        { name: "Session" }, // 2
        { name: "Deep" }, // 3
        { name: "ArrayBuffer" }, // 4
        { name: "store", size: 8 * MB }, // 5
        { name: "ArrayBuffer" }, // 6
        { name: "store", size: 1000 }, // 7
      ],
      [
        [0, "host", 1],
        [0, "cache", 4, "weak"],
        [1, "activeSession", 2],
        [2, "deep", 3],
        [3, "buffer", 4],
        [4, "backing_store", 5, "internal"],
        [2, "small", 6],
        [6, "backing_store", 7, "internal"],
      ],
    );
    const census = bufferOwnersFromHeapSnapshot(heap, RULES);
    expect(census.owners).toEqual({ session: { bytes: 8 * MB, buffers: 1 } });
    expect(census.totalBytes).toBe(8 * MB + 1000);
  });
});
