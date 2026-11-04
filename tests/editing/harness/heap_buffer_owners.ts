/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Who holds the big ArrayBuffers, from a V8 heap snapshot (TM-373).
 *
 * `usedJSHeapSize` misses ArrayBuffer backing stores, which is where a 4096²
 * chunk lives, and a walk of object fields misses buffers held only by a
 * closure (a lazy content ref, a history entry). A heap snapshot sees both.
 *
 * Each backing store of at least `minBytes` gets the shortest retaining path
 * from the GC roots (breadth-first, weak edges skipped) as a list of edge
 * names. The first owner rule whose `match` names appear in that path, in
 * order, owns the buffer; a buffer no rule matches is reported under its path.
 */

import type { Page } from "@playwright/test";

export interface HeapSnapshotJson {
  readonly snapshot: {
    readonly meta: {
      readonly node_fields: readonly string[];
      readonly node_types: readonly [readonly string[], ...unknown[]];
      readonly edge_fields: readonly string[];
      readonly edge_types: readonly [readonly string[], ...unknown[]];
    };
  };
  readonly nodes: ArrayLike<number>;
  readonly edges: ArrayLike<number>;
  readonly strings: readonly string[];
}

export interface BufferOwnerRule {
  readonly label: string;
  /** Edge names that must appear in the retaining path, in this order. */
  readonly match: readonly string[];
  /** Split the owner by the edge right after the match: `label.<edge>`. */
  readonly splitByNextEdge?: boolean;
}

export interface BufferOwnerTotal {
  readonly bytes: number;
  readonly buffers: number;
}

export interface BufferOwnerCensus {
  /** By owner label (a rule's, or `label.<edge>` when split); only labels that own something. */
  readonly owners: Record<string, BufferOwnerTotal>;
  /** Buffers no rule matched, by their retaining path (`a.b.c`). */
  readonly unmatched: Record<string, BufferOwnerTotal>;
  /** Every backing store in the snapshot, whatever its size. */
  readonly totalBytes: number;
  /**
   * Reachable objects that have every one of `objectEdges`' own edges (e.g.
   * `overlay` + `historyJournal`: an edit session). 0 when not asked.
   */
  readonly objectsWithEdges: number;
}

const BACKING_STORE_EDGE = "backing_store";
/** Edge types whose name is an index, not a string. */
const INDEX_EDGE_TYPES = new Set(["element", "hidden"]);

/** Index just past the last of `names` found in `path` in order, or -1. */
function endOfMatch(path: readonly string[], names: readonly string[]): number {
  let next = 0;
  for (const [index, name] of path.entries()) {
    if (name !== names[next]) continue;
    next++;
    if (next === names.length) return index + 1;
  }
  return names.length === 0 ? 0 : -1;
}

function ownerOf(
  path: readonly string[],
  rules: readonly BufferOwnerRule[],
): string | undefined {
  for (const rule of rules) {
    const end = endOfMatch(path, rule.match);
    if (end < 0) continue;
    return rule.splitByNextEdge === true && end < path.length
      ? `${rule.label}.${path[end]}`
      : rule.label;
  }
  return undefined;
}

function addTo(
  totals: Record<string, BufferOwnerTotal>,
  key: string,
  bytes: number,
): void {
  const total = totals[key] ?? { bytes: 0, buffers: 0 };
  totals[key] = { bytes: total.bytes + bytes, buffers: total.buffers + 1 };
}

export function bufferOwnersFromHeapSnapshot(
  heap: HeapSnapshotJson,
  rules: readonly BufferOwnerRule[],
  minBytes = 1024 * 1024,
  objectEdges: readonly string[] = [],
): BufferOwnerCensus {
  const { meta } = heap.snapshot;
  const nodeFieldCount = meta.node_fields.length;
  const edgeFieldCount = meta.edge_fields.length;
  const selfSizeField = meta.node_fields.indexOf("self_size");
  const edgeCountField = meta.node_fields.indexOf("edge_count");
  const edgeTypeField = meta.edge_fields.indexOf("type");
  const edgeNameField = meta.edge_fields.indexOf("name_or_index");
  const edgeTargetField = meta.edge_fields.indexOf("to_node");
  const edgeTypes = meta.edge_types[0];
  const { nodes, edges, strings } = heap;
  const nodeCount = nodes.length / nodeFieldCount;

  // Node i's edges are [firstEdge[i], firstEdge[i + 1]) in `edges`.
  const firstEdge = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) {
    firstEdge[i + 1] =
      firstEdge[i] +
      nodes[i * nodeFieldCount + edgeCountField] * edgeFieldCount;
  }
  const edgeName = (edge: number): string => {
    const nameOrIndex = edges[edge + edgeNameField];
    return INDEX_EDGE_TYPES.has(edgeTypes[edges[edge + edgeTypeField]])
      ? String(nameOrIndex)
      : strings[nameOrIndex];
  };

  // Breadth-first from the root (node 0): the shortest retaining path.
  const parent = new Int32Array(nodeCount).fill(-1);
  const parentEdge = new Int32Array(nodeCount).fill(-1);
  const visited = new Uint8Array(nodeCount);
  visited[0] = 1;
  const queue = new Int32Array(nodeCount);
  let head = 0;
  let tail = 0;
  queue[tail++] = 0;
  while (head < tail) {
    const node = queue[head++];
    for (
      let edge = firstEdge[node];
      edge < firstEdge[node + 1];
      edge += edgeFieldCount
    ) {
      if (edgeTypes[edges[edge + edgeTypeField]] === "weak") continue;
      const target = edges[edge + edgeTargetField] / nodeFieldCount;
      if (visited[target]) continue;
      visited[target] = 1;
      parent[target] = node;
      parentEdge[target] = edge;
      queue[tail++] = target;
    }
  }

  const owners: Record<string, BufferOwnerTotal> = {};
  const unmatched: Record<string, BufferOwnerTotal> = {};
  let totalBytes = 0;
  for (let node = 1; node < nodeCount; node++) {
    if (parentEdge[node] < 0) continue;
    if (edgeName(parentEdge[node]) !== BACKING_STORE_EDGE) continue;
    const bytes = nodes[node * nodeFieldCount + selfSizeField];
    totalBytes += bytes;
    if (bytes < minBytes) continue;
    const path: string[] = [];
    for (let current = node; parent[current] >= 0; current = parent[current]) {
      path.push(edgeName(parentEdge[current]));
    }
    path.reverse();
    const owner = ownerOf(path, rules);
    if (owner !== undefined) addTo(owners, owner, bytes);
    else addTo(unmatched, path.join("."), bytes);
  }
  let objectsWithEdges = 0;
  if (objectEdges.length > 0) {
    for (let node = 0; node < nodeCount; node++) {
      if (!visited[node]) continue;
      const names = new Set<string>();
      for (
        let edge = firstEdge[node];
        edge < firstEdge[node + 1];
        edge += edgeFieldCount
      ) {
        names.add(edgeName(edge));
      }
      if (objectEdges.every((name) => names.has(name))) objectsWithEdges++;
    }
  }
  return { owners, unmatched, totalBytes, objectsWithEdges };
}

export interface HeapBufferMeasurement {
  /** CDP `Runtime.getHeapUsage` after the GC; `backingStorageSize` is the buffers. */
  readonly usage: {
    readonly usedSize: number;
    readonly backingStorageSize?: number;
  };
  readonly census: BufferOwnerCensus;
}

/**
 * Force a GC on `page`'s main thread, read V8's heap usage, take a heap
 * snapshot and split its buffers by `rules`. Chromium only (CDP).
 */
export async function measureHeapBuffers(
  page: Page,
  rules: readonly BufferOwnerRule[],
  options: { minBytes?: number; objectEdges?: readonly string[] } = {},
): Promise<HeapBufferMeasurement> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const usage = (await cdp.send(
      "Runtime.getHeapUsage",
    )) as HeapBufferMeasurement["usage"];
    const parts: string[] = [];
    const onChunk = (event: { chunk: string }) => parts.push(event.chunk);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    const heap = JSON.parse(parts.join("")) as HeapSnapshotJson;
    return {
      usage,
      census: bufferOwnersFromHeapSnapshot(
        heap,
        rules,
        options.minBytes,
        options.objectEdges,
      ),
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}
