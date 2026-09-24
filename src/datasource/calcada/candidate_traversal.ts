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
 * @file Depth-first ordering of the candidates a trace works through.
 *
 * A proofreader following a branch wants to see where that branch goes, not to
 * be thrown across the cell between unrelated contacts. So accepting a
 * candidate puts the segment it just merged at the head of the queue: its own
 * candidates come next, and only when the branch is answered does the queue
 * fall back to whatever the seed offered. That is a call stack, and the pool's
 * ORDER is what encodes it — score ranks entries within one insertion and
 * nothing more. Picking the best-scoring entry pool-wide, as a flat list would,
 * is exactly the jumping-about this exists to stop.
 *
 * Kept free of neuroglancer state so the ordering can be tested on its own.
 */

import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";

export interface PoolEntry {
  candidate: EdgeCandidate;
  /** 0 for what the seed offered, one more for each accepted candidate. */
  depth: number;
}

function byScoreDescending(a: EdgeCandidate, b: EdgeCandidate) {
  return b.score - a.score;
}

export function seedPool(candidates: EdgeCandidate[]): PoolEntry[] {
  return [...candidates]
    .sort(byScoreDescending)
    .map((candidate) => ({ candidate, depth: 0 }));
}

/**
 * Put a newly merged segment's own candidates at the head of the pool.
 *
 * Duplicates are dropped rather than stacked: the same partner is often
 * reachable from two pieces of the same segment, and a second copy would ask
 * the proofreader the same question twice.
 */
export function prependChildren(
  pool: PoolEntry[],
  children: EdgeCandidate[],
  parentDepth: number,
  decided: ReadonlySet<bigint>,
): PoolEntry[] {
  const known = new Set(pool.map((entry) => entry.candidate.lineId));
  const fresh = children
    .filter(
      (candidate) =>
        !known.has(candidate.lineId) && !decided.has(candidate.lineId),
    )
    .sort(byScoreDescending)
    .map((candidate) => ({ candidate, depth: parentDepth + 1 }));
  return [...fresh, ...pool];
}

/**
 * A score threshold hides entries rather than dropping them. They keep their
 * place in the stack, so lowering the threshold brings back what it skipped in
 * the order the walk would have met it.
 */
function isOpen(
  entry: PoolEntry,
  decided: ReadonlySet<bigint>,
  minScore: number,
): boolean {
  return (
    !decided.has(entry.candidate.lineId) && entry.candidate.score >= minScore
  );
}

export function nextEntry(
  pool: readonly PoolEntry[],
  decided: ReadonlySet<bigint>,
  minScore = 0,
): PoolEntry | undefined {
  return pool.find((entry) => isOpen(entry, decided, minScore));
}

export function remainingCount(
  pool: readonly PoolEntry[],
  decided: ReadonlySet<bigint>,
  minScore = 0,
): number {
  return pool.filter((entry) => isOpen(entry, decided, minScore)).length;
}

export function prunePool(
  pool: readonly PoolEntry[],
  keep: (candidate: EdgeCandidate) => boolean,
): PoolEntry[] {
  return pool.filter((entry) => keep(entry.candidate));
}
