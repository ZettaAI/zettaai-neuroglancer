/**
 * Merging debug graphs fetched for several segments at once.
 *
 * The backend answers one root per call, so debugging N selected segments is N
 * calls whose results have to become one overlay. Kept out of frontend.ts and
 * free of any neuroglancer state so it can be tested directly.
 */

export interface DebugPiece {
  id: bigint;
  center: [number, number, number];
  anchor: "rep" | "bbox";
  external: boolean;
  /**
   * Which debugged root owns this piece, stamped by mergeDebugGraphs. The
   * server answers one root at a time and does not repeat it per piece, so it
   * is only known once a response is attributed to the root it came from.
   * Absent on a piece that is external to every root being debugged.
   */
  root?: bigint;
}

export interface DebugEdge {
  a: bigint;
  b: bigint;
  affinity: number;
  area: number;
  status: string;
}

export interface DebugGraph {
  pieces: DebugPiece[];
  edges: DebugEdge[];
}

/**
 * One segment's graph as the server answered it. `rootId` is what the server
 * resolved the requested id to, which is how several selected ids that turn out
 * to name the same segment — a click that landed on a piece, say — collapse to
 * one debugged root. A merge of several of these has no single root, which is
 * why it is a separate type from DebugGraph rather than an optional field.
 */
export interface RootDebugGraph extends DebugGraph {
  rootId: bigint;
}

/**
 * Fold several roots' debug graphs into one.
 *
 * Two roots that touch report the same piece twice — once as their own, once as
 * the other's `external` neighbour. Keeping both would draw the piece twice and,
 * worse, let the external copy win and paint it as "outside the selection" when
 * it is in fact part of another debugged root. So a piece is kept once, and an
 * owned copy always beats an external one.
 *
 * Edges are deduplicated on the unordered pair for the same reason: an edge
 * between two debugged roots is returned by both.
 */
export function mergeDebugGraphs(graphs: RootDebugGraph[]): DebugGraph {
  const pieceById = new Map<bigint, DebugPiece>();
  for (const graph of graphs) {
    for (const piece of graph.pieces) {
      const existing = pieceById.get(piece.id);
      if (existing === undefined || (existing.external && !piece.external)) {
        // The owning root travels with the piece so the overlay can colour by
        // segment. An external piece belongs to no debugged root, unless
        // another root owns it — and that copy is the one kept here.
        pieceById.set(
          piece.id,
          piece.external ? piece : { ...piece, root: graph.rootId },
        );
      }
    }
  }

  const edgeByPair = new Map<string, DebugEdge>();
  for (const graph of graphs) {
    for (const edge of graph.edges) {
      const [lo, hi] = edge.a <= edge.b ? [edge.a, edge.b] : [edge.b, edge.a];
      const key = `${lo}-${hi}`;
      if (!edgeByPair.has(key)) edgeByPair.set(key, edge);
    }
  }

  return {
    pieces: [...pieceById.values()],
    edges: [...edgeByPair.values()],
  };
}
