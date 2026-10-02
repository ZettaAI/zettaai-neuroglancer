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
 * @file What stays on screen when a trace ends: what the review built, less
 * the roots its edits retired and the candidate that was never accepted.
 */

export interface TraceExitRoots {
  retired: ReadonlySet<bigint>;
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
