import { describe, expect, it, vi } from "vitest";
import type { GraphFacts } from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  parsePieceGraphContext,
  PieceGraphContextCache,
} from "#src/datasource/calcada/piece_graph_context.js";

const classes = {
  perikaryon: 0,
  dendrite: 9,
  axon: 1,
  glia: 0,
  vasculature: 0,
  nucleus: 0,
  ecs: 0,
  other: 0,
};

// A chain 1-2-3 plus 2-4, as the server would answer for piece 1 at 2 hops.
function response(truncated = false) {
  return {
    pieces: {
      "1": { voxels: 10, classes, has_info: true },
      "2": { voxels: 20, classes, has_info: true },
      "3": { voxels: 30, classes, has_info: false },
      "4": { voxels: 40, classes, has_info: true },
    },
    edges: [
      ["1", "2", true],
      ["2", "3", true],
      ["2", "4", false],
    ],
    parts: { "1": { "400": { edges: 2, voxels: 100 } } },
    truncated,
  };
}

describe("parsePieceGraphContext", () => {
  it("reads pieces, edges both ways, parts and the truncation flag", () => {
    const parsed = parsePieceGraphContext(response(true));
    expect(parsed.pieces.get(3n)).toEqual({
      pieceId: 3n,
      voxels: 30,
      classes,
      hasInfo: false,
    });
    expect(parsed.adjacency.get(2n)?.sort()).toEqual([1n, 3n, 4n]);
    expect(parsed.parts.get(1n)?.get(400)).toEqual({ edges: 2, voxels: 100 });
    expect(parsed.truncated).toBe(true);
  });
});

describe("PieceGraphContextCache", () => {
  it("answers neighbours within the requested hops, excluding the piece", async () => {
    const fetch = vi.fn(async () => response());
    const cache = new PieceGraphContextCache(fetch);
    await cache.ensure([1n], { hops: 2, partSizes: [400] });
    expect(cache.neighbours(1n, 1)?.map((p) => p.pieceId)).toEqual([2n]);
    expect(
      cache
        .neighbours(1n, 2)
        ?.map((p) => p.pieceId)
        .sort(),
    ).toEqual([2n, 3n, 4n]);
    expect(cache.part(1n, 400)).toEqual({ edges: 2, voxels: 100 });
  });

  it("does not answer for more hops or other budgets than it asked for", async () => {
    const cache = new PieceGraphContextCache(async () => response());
    await cache.ensure([1n], { hops: 2, partSizes: [400] });
    expect(cache.neighbours(1n, 3)).toBeUndefined();
    expect(cache.neighbours(9n, 1)).toBeUndefined();
    expect(cache.part(1n, 500)).toBeUndefined();
    expect(cache.part(2n, 400)).toBeUndefined();
  });

  it("says a part is absent when it asked and the server had none", async () => {
    const cache = new PieceGraphContextCache(async () => ({
      pieces: {},
      edges: [],
      parts: {},
    }));
    await cache.ensure([5n], { hops: 0, partSizes: [400] });
    expect(cache.part(5n, 400)).toBe(null);
  });

  it("fetches only what is missing, and again when more hops are needed", async () => {
    const fetch = vi.fn(async () => response());
    const cache = new PieceGraphContextCache(fetch);
    await cache.ensure([1n], { hops: 2, partSizes: [] });
    await cache.ensure([1n], { hops: 1, partSizes: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.ensure([1n], { hops: 3, partSizes: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith([1n], 3, []);
  });

  it("asks in chunks the server accepts", async () => {
    const fetch = vi.fn(async (_pieces: bigint[]) => ({
      pieces: {},
      edges: [],
      parts: {},
    }));
    const cache = new PieceGraphContextCache(fetch);
    const many = Array.from({ length: 12_000 }, (_, i) => BigInt(i + 1));
    await cache.ensure(many, { hops: 1, partSizes: [] });
    expect(fetch.mock.calls.map((call) => call[0].length)).toEqual([
      5000, 5000, 2000,
    ]);
  });

  it("forgets everything on clear and reports truncation", async () => {
    const fetch = vi.fn(async () => response(true));
    const cache = new PieceGraphContextCache(fetch);
    await cache.ensure([1n], { hops: 1, partSizes: [] });
    expect(cache.truncated).toBe(true);
    cache.clear();
    expect(cache.truncated).toBe(false);
    expect(cache.neighbours(1n, 1)).toBeUndefined();
  });

  it("drops an answer that arrives after a clear", async () => {
    let answer: (value: unknown) => void = () => {};
    const cache = new PieceGraphContextCache(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const pending = cache.ensure([1n], { hops: 1, partSizes: [] });
    cache.clear();
    answer(response(true));
    expect(await pending).toBe(false);
    expect(cache.neighbours(1n, 1)).toBeUndefined();
    expect(cache.truncated).toBe(false);
  });

  it("fills what evaluation misses, round by round", async () => {
    const fetch = vi.fn(
      async (pieces: bigint[], hops: number, partSizes: number[]) => {
        if (hops > 0) return response();
        return {
          pieces: {},
          edges: [],
          parts: Object.fromEntries(
            pieces.map((piece) => [
              String(piece),
              Object.fromEntries(
                partSizes.map((size) => [size, { edges: 1, voxels: 5 }]),
              ),
            ]),
          ),
        };
      },
    );
    const cache = new PieceGraphContextCache(fetch);
    // A neighbour count whose body asks each neighbour for its bond.
    const evaluate = (graph: GraphFacts) => {
      for (const neighbour of graph.neighbours(1n, 1) ?? []) {
        graph.part(neighbour.pieceId, 400);
      }
    };
    expect(await cache.fill(evaluate)).toBe(true);
    expect(
      fetch.mock.calls.map(([pieces, hops, sizes]) => [pieces, hops, sizes]),
    ).toEqual([
      [[1n], 1, []],
      [[2n], 0, [400]],
    ]);
    expect(cache.part(2n, 400)).toEqual({ edges: 1, voxels: 5 });
    await cache.fill(evaluate);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("asks nothing when the filter needs no graph", async () => {
    const fetch = vi.fn(async () => response());
    const cache = new PieceGraphContextCache(fetch);
    await cache.ensure([1n], { hops: 0, partSizes: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});
