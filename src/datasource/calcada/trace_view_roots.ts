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
 * @file Which roots a trace keeps on screen: while it runs, and when it ends.
 */

export interface TraceExitRoots {
  retired: { has(id: bigint): boolean };
  candidateRoot: bigint | undefined;
  /**
   * The live seed, resolved from its piece. It stays even if retired: undoing
   * an accept brings back the very root that accept retired.
   */
  seedRoot: bigint | undefined;
}

export function rootsKeptOnExit(
  ids: Iterable<bigint>,
  { retired, candidateRoot, seedRoot }: TraceExitRoots,
): Set<bigint> {
  const kept = new Set<bigint>();
  for (const id of ids) {
    if (id === candidateRoot) continue;
    if (retired.has(id) && id !== seedRoot) continue;
    kept.add(id);
  }
  return kept;
}

export interface SplitPartsView {
  /** Roots cuts made during this trace. */
  splitParts: Iterable<bigint>;
  keepSplitParts: boolean;
  retired: { has(id: bigint): boolean };
}

/**
 * The seed and the candidate, and, when asked, the parts of the segments cut
 * during the trace that are still live.
 */
export function rootsShownWhileTracing(
  seedRoot: bigint,
  candidateRoot: bigint | undefined,
  { splitParts, keepSplitParts, retired }: SplitPartsView,
): bigint[] {
  const shown =
    candidateRoot === undefined ? [seedRoot] : [seedRoot, candidateRoot];
  if (!keepSplitParts) return shown;
  for (const part of splitParts) {
    if (!retired.has(part) && !shown.includes(part)) shown.push(part);
  }
  return shown;
}
