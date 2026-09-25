/**
 * @license
 * Copyright 2024 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export function isStaleRoot(
  candidateRoot: bigint,
  oldRoots: ReadonlySet<bigint>,
): boolean {
  return oldRoots.has(candidateRoot);
}

export type CandidateEditOutcome =
  | "absorbed"
  | "rerooted"
  | "unaffected"
  | "superseded";

/**
 * A piece belongs to no root once a cut has replaced it with two halves, and the
 * server answers that with a zero. Taking the zero for a root put the candidate
 * on a segment that does not exist; the candidate has to come from the server
 * again instead, because the server is what decided which half now holds it.
 */
export function classifyCandidateEdit(
  seedRootChanged: boolean,
  newSeedRoot: bigint,
  newPartnerRoot: bigint,
): CandidateEditOutcome {
  if (newPartnerRoot === 0n || newSeedRoot === 0n) return "superseded";
  if (newPartnerRoot === newSeedRoot) return "absorbed";
  if (seedRootChanged) return "unaffected";
  return "rerooted";
}

/** One piece a carve replaced, with the two halves that took it. */
export interface CarvedPiece {
  old: bigint;
  blue: bigint;
  red: bigint;
}

/**
 * Place each carved parent in the root that took it, where a single root did.
 *
 * A carve rewrites voxels: the parent's id is gone from storage, replaced by its
 * two halves. Chunks already decoded in the browser still carry the parent, and
 * the split response lists it nowhere, so those voxels resolve to no segment —
 * the slice view stops painting them, hover stops highlighting, and a click has
 * only the bare piece id to select.
 *
 * Carrying the parent into a root's group fixes that wherever both halves landed
 * in the same root, which is every carve that leaves the segment whole. Where the
 * halves landed in different roots the parent names two segments at once, and
 * putting it in either would give half its voxels the wrong one — those are
 * returned as `ambiguous`, and only re-reading the voxels can resolve them.
 */
export function componentsWithCarvedParents(
  components: bigint[][],
  carved: readonly CarvedPiece[],
): { components: bigint[][]; ambiguous: bigint[] } {
  const componentOf = new Map<bigint, number>();
  components.forEach((pieces, index) => {
    for (const piece of pieces) componentOf.set(piece, index);
  });
  const out = components.map((pieces) => [...pieces]);
  const ambiguous: bigint[] = [];
  for (const piece of carved) {
    const blue = componentOf.get(piece.blue);
    const red = componentOf.get(piece.red);
    if (blue !== undefined && blue === red) {
      out[blue].push(piece.old);
    } else {
      ambiguous.push(piece.old);
    }
  }
  return { components: out, ambiguous };
}

/**
 * The pieces a merge brought into the seed: those of every root it absorbed
 * other than the seed's own. Empty for anything but a merge into the seed.
 */
export function piecesMergedIntoSeed(
  seedBefore: bigint,
  seedAfter: bigint,
  newRoots: { size: number; has(id: bigint): boolean } | undefined,
  piecesBefore: ReadonlyMap<bigint, ReadonlySet<bigint>>,
): Set<bigint> {
  const brought = new Set<bigint>();
  const mergedIntoSeed =
    seedAfter !== seedBefore &&
    newRoots !== undefined &&
    newRoots.size === 1 &&
    newRoots.has(seedAfter) &&
    piecesBefore.has(seedBefore);
  if (!mergedIntoSeed) return brought;
  for (const [root, pieces] of piecesBefore) {
    if (root === seedBefore) continue;
    for (const piece of pieces) {
      if (piece !== root) brought.add(piece);
    }
  }
  return brought;
}
