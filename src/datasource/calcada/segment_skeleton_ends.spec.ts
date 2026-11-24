import { describe, expect, it } from "vitest";
import type { SegmentSkeleton } from "#src/datasource/calcada/segment_skeleton_ends.js";
import {
  decodeSegmentSkeleton,
  segmentEndsNm,
} from "#src/datasource/calcada/segment_skeleton_ends.js";

type Point = [number, number, number];

function skeleton(
  vertices: Point[],
  edges: [number, number][],
  ends: number[],
): SegmentSkeleton {
  return {
    verticesNm: Float32Array.from(vertices.flat()),
    edges: Uint32Array.from(edges.flat()),
    isEnd: vertices.map((_, i) => ends.includes(i)),
  };
}

function encode(
  vertices: Point[],
  edges: [number, number][],
  ends: number[],
): ArrayBuffer {
  const numVertices = vertices.length;
  const buffer = new ArrayBuffer(
    8 + numVertices * 12 + edges.length * 8 + numVertices * 8,
  );
  const view = new DataView(buffer);
  view.setUint32(0, numVertices, true);
  view.setUint32(4, edges.length, true);
  let at = 8;
  for (const value of vertices.flat()) {
    view.setFloat32(at, value, true);
    at += 4;
  }
  for (const index of edges.flat()) {
    view.setUint32(at, index, true);
    at += 4;
  }
  at += numVertices * 4;
  for (let i = 0; i < numVertices; ++i) {
    view.setFloat32(at, ends.includes(i) ? 1 : 0, true);
    at += 4;
  }
  return buffer;
}

// A Y: the stem runs from 0 to 2, where it forks into a short and a long arm.
const FORK: Point[] = [
  [0, 0, 0],
  [100, 0, 0],
  [200, 0, 0],
  [300, 100, 0],
  [300, -100, 0],
  [400, -200, 0],
  [500, -300, 0],
];
const FORK_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [2, 4],
  [4, 5],
  [5, 6],
];
const FORK_ENDS = [0, 3, 6];

describe("decodeSegmentSkeleton", () => {
  it("reads vertices, edges and the end flags in wire order", () => {
    const decoded = decodeSegmentSkeleton(encode(FORK, FORK_EDGES, FORK_ENDS));
    expect(Array.from(decoded.verticesNm)).toEqual(FORK.flat());
    expect(Array.from(decoded.edges)).toEqual(FORK_EDGES.flat());
    expect(decoded.isEnd).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  it("refuses a truncated skeleton", () => {
    const whole = encode(FORK, FORK_EDGES, FORK_ENDS);
    expect(() =>
      decodeSegmentSkeleton(whole.slice(0, whole.byteLength - 4)),
    ).toThrow("truncated");
  });

  it("refuses an edge to a vertex that is not there", () => {
    expect(() =>
      decodeSegmentSkeleton(encode([[0, 0, 0]], [[0, 5]], [0])),
    ).toThrow("vertex");
  });
});

describe("segmentEndsNm", () => {
  it("orders the ends by how far along the skeleton they are, farthest first", () => {
    expect(
      segmentEndsNm(skeleton(FORK, FORK_EDGES, FORK_ENDS), [0, 0, 0]),
    ).toEqual([
      [500, -300, 0],
      [300, 100, 0],
      [0, 0, 0],
    ]);
  });

  it("measures along the skeleton, not in a straight line", () => {
    // A U: the far tip of the U sits right next to where it starts.
    const vertices: Point[] = [
      [0, 0, 0],
      [0, 1000, 0],
      [100, 1000, 0],
      [100, 0, 0],
      [-500, 0, 0],
    ];
    const edges: [number, number][] = [
      [4, 0],
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    expect(segmentEndsNm(skeleton(vertices, edges, [3, 4]), [0, 0, 0])).toEqual(
      [
        [100, 0, 0],
        [-500, 0, 0],
      ],
    );
  });

  it("starts from the vertex nearest the contact", () => {
    expect(
      segmentEndsNm(skeleton(FORK, FORK_EDGES, FORK_ENDS), [510, -290, 0])[0],
    ).toEqual([0, 0, 0]);
  });

  it("puts the ends it cannot reach last", () => {
    const vertices: Point[] = [
      [0, 0, 0],
      [100, 0, 0],
      [5000, 0, 0],
    ];
    expect(
      segmentEndsNm(skeleton(vertices, [[0, 1]], [0, 1, 2]), [0, 0, 0]),
    ).toEqual([
      [100, 0, 0],
      [0, 0, 0],
      [5000, 0, 0],
    ]);
  });

  it("has no ends for an empty skeleton", () => {
    expect(segmentEndsNm(skeleton([], [], []), [0, 0, 0])).toEqual([]);
  });
});
