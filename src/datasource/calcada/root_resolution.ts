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
