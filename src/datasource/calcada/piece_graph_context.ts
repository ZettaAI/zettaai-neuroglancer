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
 * @file The piece graph around the pieces a filter judges, as calcada's
 * /piece_graph_context returns it, cached for the branch in use until the
 * graph is edited.
 */

import type {
  GraphFacts,
  PieceFacts,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import { parseClassCounts } from "#src/datasource/calcada/candidate_heat.js";
import { parseUint64 } from "#src/util/json.js";

/** The most pieces calcada accepts in one request. */
const PIECES_PER_REQUEST = 5000;
// Each round answers one more level of nesting: neighbours of neighbours, a
// bond inside a neighbour count. No real filter nests deeper than this.
const MAX_FILL_ROUNDS = 8;

type Part = { edges: number; voxels: number };

export interface PieceGraphContextResponse {
  pieces: Map<bigint, PieceFacts>;
  adjacency: Map<bigint, bigint[]>;
  parts: Map<bigint, Map<number, Part>>;
  truncated: boolean;
}

export interface GraphNeeds {
  hops: number;
  partSizes: number[];
}

/** Whether a filter with these needs reads the piece graph at all. */
function needsGraph(needs: GraphNeeds): boolean {
  return needs.hops > 0 || needs.partSizes.length > 0;
}

export function parsePieceGraphContext(
  json: unknown,
): PieceGraphContextResponse {
  const body = (json ?? {}) as {
    pieces?: Record<
      string,
      { voxels?: number; classes?: unknown; has_info?: boolean }
    >;
    edges?: [string, string, boolean][];
    parts?: Record<string, Record<string, Part>>;
    truncated?: boolean;
  };
  const pieces = new Map<bigint, PieceFacts>();
  for (const [id, piece] of Object.entries(body.pieces ?? {})) {
    const pieceId = parseUint64(id);
    pieces.set(pieceId, {
      pieceId,
      voxels: Number(piece.voxels ?? 0),
      classes: parseClassCounts(piece.classes),
      hasInfo: piece.has_info === true,
    });
  }
  const adjacency = new Map<bigint, bigint[]>();
  const link = (from: bigint, to: bigint) => {
    const list = adjacency.get(from);
    if (list === undefined) adjacency.set(from, [to]);
    else list.push(to);
  };
  for (const [a, b] of body.edges ?? []) {
    const pieceA = parseUint64(a);
    const pieceB = parseUint64(b);
    link(pieceA, pieceB);
    link(pieceB, pieceA);
  }
  const parts = new Map<bigint, Map<number, Part>>();
  for (const [id, byBudget] of Object.entries(body.parts ?? {})) {
    parts.set(
      parseUint64(id),
      new Map(
        Object.entries(byBudget).map(([budget, part]) => [
          Number(budget),
          { edges: Number(part.edges), voxels: Number(part.voxels) },
        ]),
      ),
    );
  }
  return { pieces, adjacency, parts, truncated: body.truncated === true };
}

/** The graph as a filter reads it, noting every question it cannot answer. */
class MissRecorder implements GraphFacts {
  private readonly missing = new Map<
    bigint,
    { hops: number; partSizes: Set<number> }
  >();

  constructor(private readonly graph: GraphFacts) {}

  private miss(piece: bigint) {
    let entry = this.missing.get(piece);
    if (entry === undefined) {
      entry = { hops: 0, partSizes: new Set() };
      this.missing.set(piece, entry);
    }
    return entry;
  }

  neighbours(piece: bigint, hops: number) {
    const answer = this.graph.neighbours(piece, hops);
    if (answer === undefined) {
      const entry = this.miss(piece);
      entry.hops = Math.max(entry.hops, hops);
    }
    return answer;
  }

  part(piece: bigint, maxSize: number) {
    const answer = this.graph.part(piece, maxSize);
    if (answer === undefined) this.miss(piece).partSizes.add(maxSize);
    return answer;
  }

  /** The misses as requests: pieces sharing the same needs go together. */
  requests(): [GraphNeeds, bigint[]][] {
    const byNeeds = new Map<string, [GraphNeeds, bigint[]]>();
    for (const [piece, entry] of this.missing) {
      const needs = {
        hops: entry.hops,
        partSizes: [...entry.partSizes].sort((a, b) => a - b),
      };
      const key = `${needs.hops}:${needs.partSizes.join(",")}`;
      const group = byNeeds.get(key) ?? [needs, []];
      group[1].push(piece);
      byNeeds.set(key, group);
    }
    return [...byNeeds.values()];
  }
}

export class PieceGraphContextCache implements GraphFacts {
  private pieces = new Map<bigint, PieceFacts>();
  private adjacency = new Map<bigint, Set<bigint>>();
  private parts = new Map<bigint, Map<number, Part>>();
  // What each piece was asked for: its neighbourhood is complete to that
  // many hops, and its part is known for those budgets.
  private asked = new Map<bigint, { hops: number; partSizes: Set<number> }>();
  private truncatedAny = false;
  // Bumped by clear, so an answer still in flight lands nowhere.
  private generation = 0;

  constructor(
    private fetch: (
      pieces: bigint[],
      hops: number,
      partSizes: number[],
    ) => Promise<unknown>,
  ) {}

  get truncated() {
    return this.truncatedAny;
  }

  clear() {
    this.pieces.clear();
    this.adjacency.clear();
    this.parts.clear();
    this.asked.clear();
    this.truncatedAny = false;
    ++this.generation;
  }

  private coversPiece(piece: bigint, needs: GraphNeeds): boolean {
    const asked = this.asked.get(piece);
    return (
      asked !== undefined &&
      asked.hops >= needs.hops &&
      needs.partSizes.every((size) => asked.partSizes.has(size))
    );
  }

  /** False when a clear overtook the answer, which then went unused. */
  async ensure(pieces: Iterable<bigint>, needs: GraphNeeds): Promise<boolean> {
    if (!needsGraph(needs)) return true;
    const missing = [...new Set(pieces)].filter(
      (piece) => !this.coversPiece(piece, needs),
    );
    const { generation } = this;
    for (let start = 0; start < missing.length; start += PIECES_PER_REQUEST) {
      const chunk = missing.slice(start, start + PIECES_PER_REQUEST);
      const json = await this.fetch(chunk, needs.hops, needs.partSizes);
      if (generation !== this.generation) return false;
      this.merge(parsePieceGraphContext(json));
      for (const piece of chunk) {
        const asked = this.asked.get(piece);
        this.asked.set(piece, {
          hops: Math.max(asked?.hops ?? 0, needs.hops),
          partSizes: new Set([...(asked?.partSizes ?? []), ...needs.partSizes]),
        });
      }
    }
    return true;
  }

  /**
   * Fetch whatever `evaluate` asks the graph and does not find, until it finds
   * everything. False when a clear overtook a fetch.
   */
  async fill(evaluate: (graph: GraphFacts) => void): Promise<boolean> {
    for (let round = 0; round < MAX_FILL_ROUNDS; round++) {
      const recorder = new MissRecorder(this);
      evaluate(recorder);
      const requests = recorder.requests();
      if (requests.length === 0) return true;
      for (const [needs, pieces] of requests) {
        if (!(await this.ensure(pieces, needs))) return false;
      }
    }
    return true;
  }

  private merge(response: PieceGraphContextResponse) {
    for (const [id, facts] of response.pieces) this.pieces.set(id, facts);
    for (const [id, neighbours] of response.adjacency) {
      const known = this.adjacency.get(id) ?? new Set<bigint>();
      for (const neighbour of neighbours) known.add(neighbour);
      this.adjacency.set(id, known);
    }
    for (const [id, byBudget] of response.parts) {
      const known = this.parts.get(id) ?? new Map<number, Part>();
      for (const [budget, part] of byBudget) known.set(budget, part);
      this.parts.set(id, known);
    }
    if (response.truncated) this.truncatedAny = true;
  }

  neighbours(piece: bigint, hops: number): PieceFacts[] | undefined {
    if ((this.asked.get(piece)?.hops ?? 0) < hops) return undefined;
    const seen = new Set<bigint>([piece]);
    let frontier = [piece];
    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      const next: bigint[] = [];
      for (const current of frontier) {
        for (const neighbour of this.adjacency.get(current) ?? []) {
          if (!seen.has(neighbour)) {
            seen.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
    }
    seen.delete(piece);
    return [...seen]
      .map((id) => this.pieces.get(id))
      .filter((facts): facts is PieceFacts => facts !== undefined);
  }

  part(piece: bigint, maxSize: number): Part | null | undefined {
    if (!this.asked.get(piece)?.partSizes.has(maxSize)) return undefined;
    return this.parts.get(piece)?.get(maxSize) ?? null;
  }
}
