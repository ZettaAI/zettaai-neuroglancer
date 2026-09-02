import { describe, expect, it } from "vitest";
import type {
  DebugEdge,
  DebugGraph,
  DebugPiece,
} from "#src/datasource/calcada/debug_graph.js";
import { mergeDebugGraphs } from "#src/datasource/calcada/debug_graph.js";

function piece(id: bigint, external = false): DebugPiece {
  return { id, center: [0, 0, 0], anchor: "bbox", external };
}

function edge(a: bigint, b: bigint): DebugEdge {
  return { a, b, affinity: 1, area: 1, status: "enabled", pos: [0, 0, 0] };
}

describe("mergeDebugGraphs", () => {
  it("keeps every piece of every root", () => {
    const merged = mergeDebugGraphs([
      { pieces: [piece(1n), piece(2n)], edges: [] },
      { pieces: [piece(3n)], edges: [] },
    ]);
    expect(merged.pieces.map((p) => p.id).sort()).toEqual([1n, 2n, 3n]);
  });

  // Two debugged roots that touch each report the other's piece as external.
  // The owned copy has to win, or a piece of the selection is drawn as if it
  // were outside it.
  it("prefers the owned copy of a piece over an external one", () => {
    const merged = mergeDebugGraphs([
      { pieces: [piece(1n), piece(2n, true)], edges: [] },
      { pieces: [piece(2n), piece(1n, true)], edges: [] },
    ]);
    expect(merged.pieces).toHaveLength(2);
    expect(merged.pieces.every((p) => !p.external)).toBe(true);
  });

  it("keeps a piece external when no root owns it", () => {
    const merged = mergeDebugGraphs([
      { pieces: [piece(1n), piece(9n, true)], edges: [] },
      { pieces: [piece(2n), piece(9n, true)], edges: [] },
    ]);
    expect(merged.pieces.find((p) => p.id === 9n)?.external).toBe(true);
  });

  // An edge between two debugged roots comes back from both calls, in either
  // orientation. Drawing it twice doubles the line and the reported edge count.
  it("deduplicates an edge reported by both of its roots", () => {
    const merged = mergeDebugGraphs([
      { pieces: [], edges: [edge(1n, 2n)] },
      { pieces: [], edges: [edge(2n, 1n)] },
    ]);
    expect(merged.edges).toHaveLength(1);
  });

  it("returns an empty graph for no input", () => {
    const merged: DebugGraph = mergeDebugGraphs([]);
    expect(merged.pieces).toHaveLength(0);
    expect(merged.edges).toHaveLength(0);
  });
});
