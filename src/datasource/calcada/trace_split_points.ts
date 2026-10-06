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
 * @file Split error points while tracing: the same points detection draws,
 * for the segments the trace has on screen — the seed's and the candidate's.
 */

import type {
  GraphFacts,
  GroupNode,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  semanticsKnown,
  subjectPasses,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import type { PieceOverview } from "#src/datasource/calcada/candidate_heat.js";
import {
  pieceOverviewSubject,
  rankFlaggedPieces,
} from "#src/datasource/calcada/candidate_heat.js";
import type { SplitErrorPoint } from "#src/datasource/calcada/split_error_points.js";
import { splitErrorPoints } from "#src/datasource/calcada/split_error_points.js";
import type {
  ScoreRange,
  ZettaTraceState,
} from "#src/datasource/calcada/trace_state.js";
import { withinScoreRange } from "#src/datasource/calcada/trace_state.js";

export interface CandidateFilter {
  filter: GroupNode;
  scoreRange: ScoreRange;
}

export function currentCandidateFilter(
  state: ZettaTraceState,
): CandidateFilter {
  return { filter: state.filter.value, scoreRange: state.scoreRange.value };
}

/**
 * Whether a scored piece's best candidate passes the trace's filter. A side
 * none of these pieces has semantics for is not filtered by class, or naming
 * a class on such a graph would hide every piece.
 */
export function piecesPassing(
  pieces: readonly PieceOverview[],
  { filter, scoreRange }: CandidateFilter,
  graph: GraphFacts,
): (piece: PieceOverview) => boolean {
  const known = semanticsKnown(pieces.map(pieceOverviewSubject));
  return (piece) =>
    withinScoreRange(piece.bestScore, scoreRange) &&
    subjectPasses(pieceOverviewSubject(piece), filter, known, graph);
}

export interface TraceSplitPointsSource {
  fetchOverview(root: bigint): Promise<PieceOverview[]>;
  /** The filter as it stands, once whatever it reads about these is loaded. */
  passesOn(
    pieces: readonly PieceOverview[],
  ): Promise<(piece: PieceOverview) => boolean>;
  draw(points: SplitErrorPoint[]): void;
  reportError(error: unknown): void;
}

export class TraceSplitPoints {
  private roots: bigint[] = [];
  private readonly scored = new Map<bigint, PieceOverview[]>();
  private token = 0;

  constructor(private readonly source: TraceSplitPointsSource) {}

  /** Draw the points of these segments; a segment already scored is not asked about again. */
  async show(roots: readonly bigint[]) {
    if (
      roots.length === this.roots.length &&
      roots.every((root, i) => root === this.roots[i])
    ) {
      return;
    }
    this.roots = [...roots];
    for (const root of this.scored.keys()) {
      if (!roots.includes(root)) this.scored.delete(root);
    }
    await this.refresh();
  }

  /** The filter changed: the same scores, judged again. */
  async refresh() {
    const token = ++this.token;
    try {
      const lists = await Promise.all(
        this.roots.map((root) => this.scoresOf(root)),
      );
      if (token !== this.token) return;
      const pieces = lists.flat();
      const passes = await this.source.passesOn(pieces);
      if (token !== this.token) return;
      this.source.draw(
        splitErrorPoints(rankFlaggedPieces(pieces, passes), undefined),
      );
    } catch (e) {
      if (token === this.token) this.source.reportError(e);
    }
  }

  /** A decision changed this segment's scores; one on screen is scored again. */
  async forget(root: bigint) {
    this.scored.delete(root);
    if (this.roots.includes(root)) await this.refresh();
  }

  clear() {
    ++this.token;
    this.roots = [];
    this.scored.clear();
    this.source.draw([]);
  }

  private async scoresOf(root: bigint): Promise<PieceOverview[]> {
    const known = this.scored.get(root);
    if (known !== undefined) return known;
    const pieces = await this.source.fetchOverview(root);
    this.scored.set(root, pieces);
    return pieces;
  }
}
