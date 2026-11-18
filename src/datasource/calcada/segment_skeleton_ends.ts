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
 * @file Where a segment really ends, read from the skeleton calcada stitches
 * out of its pieces' skeletons and serves with every true end flagged.
 */

type Point3 = [number, number, number];

export interface SegmentSkeleton {
  /** x, y, z per vertex, in nanometres. */
  verticesNm: Float32Array;
  /** Vertex index pairs. */
  edges: Uint32Array;
  isEnd: boolean[];
}

const HEADER_BYTES = 8;
const VERTEX_BYTES = 12;
const EDGE_BYTES = 8;
// radius, then the end flag: one float32 each per vertex.
const ATTRIBUTE_BYTES_PER_VERTEX = 8;

/** The precomputed skeleton wire format with calcada's radius and end attributes. */
export function decodeSegmentSkeleton(buffer: ArrayBuffer): SegmentSkeleton {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error("segment skeleton is truncated");
  }
  const numVertices = view.getUint32(0, true);
  const numEdges = view.getUint32(4, true);
  const edgesOffset = HEADER_BYTES + numVertices * VERTEX_BYTES;
  const radiusOffset = edgesOffset + numEdges * EDGE_BYTES;
  const endOffset = radiusOffset + numVertices * 4;
  if (
    buffer.byteLength <
    radiusOffset + numVertices * ATTRIBUTE_BYTES_PER_VERTEX
  ) {
    throw new Error("segment skeleton is truncated");
  }
  const verticesNm = new Float32Array(buffer.slice(HEADER_BYTES, edgesOffset));
  const edges = new Uint32Array(buffer.slice(edgesOffset, radiusOffset));
  if (edges.some((vertex) => vertex >= numVertices)) {
    throw new Error("segment skeleton has an edge to a missing vertex");
  }
  const isEnd = Array.from(
    { length: numVertices },
    (_, i) => view.getFloat32(endOffset + i * 4, true) > 0,
  );
  return { verticesNm, edges, isEnd };
}

function vertexAt(skeleton: SegmentSkeleton, index: number): Point3 {
  const offset = index * 3;
  const { verticesNm } = skeleton;
  return [verticesNm[offset], verticesNm[offset + 1], verticesNm[offset + 2]];
}

function distanceNm(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function vertexCount(skeleton: SegmentSkeleton): number {
  return skeleton.isEnd.length;
}

function nearestVertex(
  skeleton: SegmentSkeleton,
  pointNm: readonly number[],
): number {
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let i = 0; i < vertexCount(skeleton); ++i) {
    const distance = distanceNm(vertexAt(skeleton, i), pointNm);
    if (distance < nearestDistance) {
      nearest = i;
      nearestDistance = distance;
    }
  }
  return nearest;
}

type Neighbours = { vertex: number; lengthNm: number }[][];

function neighboursOf(skeleton: SegmentSkeleton): Neighbours {
  const neighbours: Neighbours = Array.from(
    { length: vertexCount(skeleton) },
    () => [],
  );
  const { edges } = skeleton;
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i];
    const b = edges[i + 1];
    const lengthNm = distanceNm(vertexAt(skeleton, a), vertexAt(skeleton, b));
    neighbours[a].push({ vertex: b, lengthNm });
    neighbours[b].push({ vertex: a, lengthNm });
  }
  return neighbours;
}

/** Binary min-heap of vertices keyed by their distance so far. */
class VertexQueue {
  private entries: { vertex: number; distanceNm: number }[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(vertex: number, distanceNm: number) {
    const { entries } = this;
    entries.push({ vertex, distanceNm });
    let child = entries.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (entries[parent].distanceNm <= entries[child].distanceNm) break;
      [entries[parent], entries[child]] = [entries[child], entries[parent]];
      child = parent;
    }
  }

  pop(): { vertex: number; distanceNm: number } {
    const { entries } = this;
    const top = entries[0];
    const last = entries.pop()!;
    if (entries.length > 0) {
      entries[0] = last;
      let parent = 0;
      for (;;) {
        const left = 2 * parent + 1;
        const right = left + 1;
        let smallest = parent;
        if (
          left < entries.length &&
          entries[left].distanceNm < entries[smallest].distanceNm
        ) {
          smallest = left;
        }
        if (
          right < entries.length &&
          entries[right].distanceNm < entries[smallest].distanceNm
        ) {
          smallest = right;
        }
        if (smallest === parent) break;
        [entries[parent], entries[smallest]] = [
          entries[smallest],
          entries[parent],
        ];
        parent = smallest;
      }
    }
    return top;
  }
}

/** Distance along the skeleton from `start` to every vertex; Infinity where unreachable. */
function distancesAlongNm(skeleton: SegmentSkeleton, start: number): number[] {
  const neighbours = neighboursOf(skeleton);
  const distances = new Array<number>(vertexCount(skeleton)).fill(Infinity);
  distances[start] = 0;
  const queue = new VertexQueue();
  queue.push(start, 0);
  while (queue.size > 0) {
    const { vertex, distanceNm } = queue.pop();
    if (distanceNm > distances[vertex]) continue;
    for (const next of neighbours[vertex]) {
      const throughVertex = distanceNm + next.lengthNm;
      if (throughVertex < distances[next.vertex]) {
        distances[next.vertex] = throughVertex;
        queue.push(next.vertex, throughVertex);
      }
    }
  }
  return distances;
}

/**
 * The segment's ends, farthest along the skeleton from `fromNm` first; ends
 * the skeleton does not connect to it come last.
 */
export function segmentEndsNm(
  skeleton: SegmentSkeleton,
  fromNm: readonly number[],
): Point3[] {
  if (vertexCount(skeleton) === 0) return [];
  const distances = distancesAlongNm(skeleton, nearestVertex(skeleton, fromNm));
  const ends = skeleton.isEnd.flatMap((isEnd, i) => (isEnd ? [i] : []));
  const reachable = ends.filter((end) => Number.isFinite(distances[end]));
  const unreachable = ends.filter((end) => !Number.isFinite(distances[end]));
  reachable.sort((a, b) => distances[b] - distances[a]);
  return [...reachable, ...unreachable].map((end) => vertexAt(skeleton, end));
}
