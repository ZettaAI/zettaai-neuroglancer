import { describe, expect, it } from "vitest";
import type {
  DebugEdge,
  DebugGraph,
  DebugPiece,
} from "#src/datasource/calcada/debug_graph.js";
import {
  debugEdgeLines,
  mergeDebugGraphs,
} from "#src/datasource/calcada/debug_graph.js";

function piece(id: bigint, external = false): DebugPiece {
  return { id, center: [0, 0, 0], anchor: "bbox", external };
}

function edge(a: bigint, b: bigint, affinity = 1): DebugEdge {
  return { a, b, affinity, area: 1, status: "enabled" };
}

function anchoredPiece(id: bigint, x: number, root?: bigint): DebugPiece {
  return {
    id,
    center: [x, 0, 0],
    anchor: "rep",
    external: root === undefined,
    root,
  };
}

describe("mergeDebugGraphs", () => {
  it("keeps every piece of every root", () => {
    const merged = mergeDebugGraphs([
      { rootId: 0n, pieces: [piece(1n), piece(2n)], edges: [] },
      { rootId: 0n, pieces: [piece(3n)], edges: [] },
    ]);
    expect(merged.pieces.map((p) => p.id).sort()).toEqual([1n, 2n, 3n]);
  });

  // Two debugged roots that touch each report the other's piece as external.
  // The owned copy has to win, or a piece of the selection is drawn as if it
  // were outside it.
  it("prefers the owned copy of a piece over an external one", () => {
    const merged = mergeDebugGraphs([
      { rootId: 10n, pieces: [piece(1n), piece(2n, true)], edges: [] },
      { rootId: 20n, pieces: [piece(2n), piece(1n, true)], edges: [] },
    ]);
    expect(merged.pieces).toHaveLength(2);
    expect(merged.pieces.every((p) => !p.external)).toBe(true);
  });

  // Colouring an edge by the segment it belongs to needs the piece to know
  // which root answered for it; the server never says so per piece.
  it("stamps each owned piece with the root that reported it", () => {
    const merged = mergeDebugGraphs([
      { rootId: 10n, pieces: [piece(1n)], edges: [] },
      { rootId: 20n, pieces: [piece(2n)], edges: [] },
    ]);
    expect(merged.pieces.find((p) => p.id === 1n)?.root).toBe(10n);
    expect(merged.pieces.find((p) => p.id === 2n)?.root).toBe(20n);
  });

  it("leaves a piece no root owns without one", () => {
    const merged = mergeDebugGraphs([
      { rootId: 10n, pieces: [piece(1n), piece(9n, true)], edges: [] },
    ]);
    expect(merged.pieces.find((p) => p.id === 9n)?.root).toBeUndefined();
  });

  it("keeps a piece external when no root owns it", () => {
    const merged = mergeDebugGraphs([
      { rootId: 0n, pieces: [piece(1n), piece(9n, true)], edges: [] },
      { rootId: 0n, pieces: [piece(2n), piece(9n, true)], edges: [] },
    ]);
    expect(merged.pieces.find((p) => p.id === 9n)?.external).toBe(true);
  });

  // An edge between two debugged roots comes back from both calls, in either
  // orientation. Drawing it twice doubles the line and the reported edge count.
  it("deduplicates an edge reported by both of its roots", () => {
    const merged = mergeDebugGraphs([
      { rootId: 0n, pieces: [], edges: [edge(1n, 2n)] },
      { rootId: 0n, pieces: [], edges: [edge(2n, 1n)] },
    ]);
    expect(merged.edges).toHaveLength(1);
  });

  it("returns an empty graph for no input", () => {
    const merged: DebugGraph = mergeDebugGraphs([]);
    expect(merged.pieces).toHaveLength(0);
    expect(merged.edges).toHaveLength(0);
  });
});

describe("debugEdgeLines", () => {
  const SEGMENT_COLOR = 0x3366cc;
  const FALLBACK_COLOR = 0xffffff;
  const colorOfRoot = (root: bigint) => (root === 10n ? SEGMENT_COLOR : 0);

  // A split writes a zero-affinity edge between its halves. It is an edge of
  // the segment like any other, so the cut tool must draw it the way debug does.
  it("draws a split's zero-affinity edge in its segment's colour", () => {
    const graph: DebugGraph = {
      pieces: [anchoredPiece(1n, 0, 10n), anchoredPiece(2n, 5, 10n)],
      edges: [edge(1n, 2n, 0)],
    };
    expect(debugEdgeLines(graph, colorOfRoot, FALLBACK_COLOR).lines).toEqual([
      { from: [0, 0, 0], to: [5, 0, 0], color: SEGMENT_COLOR },
    ]);
  });

  it("draws an edge no debugged root owns in the fallback colour", () => {
    const graph: DebugGraph = {
      pieces: [anchoredPiece(1n, 0), anchoredPiece(2n, 5)],
      edges: [edge(1n, 2n)],
    };
    expect(debugEdgeLines(graph, colorOfRoot, FALLBACK_COLOR).lines).toEqual([
      { from: [0, 0, 0], to: [5, 0, 0], color: FALLBACK_COLOR },
    ]);
  });

  it("counts an edge it cannot anchor instead of drawing it", () => {
    const graph: DebugGraph = {
      pieces: [anchoredPiece(1n, 0, 10n)],
      edges: [edge(1n, 2n)],
    };
    const result = debugEdgeLines(graph, colorOfRoot, FALLBACK_COLOR);
    expect(result.lines).toEqual([]);
    expect(result.undrawable).toBe(1);
  });
});
