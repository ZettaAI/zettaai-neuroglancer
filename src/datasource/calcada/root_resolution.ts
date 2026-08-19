export function isStaleRoot(
  candidateRoot: bigint,
  oldRoots: ReadonlySet<bigint>,
): boolean {
  return oldRoots.has(candidateRoot);
}

export type CandidateEditOutcome = "absorbed" | "rerooted" | "unaffected";

export function classifyCandidateEdit(
  seedRootChanged: boolean,
  newSeedRoot: bigint,
  newPartnerRoot: bigint,
): CandidateEditOutcome {
  if (newPartnerRoot === newSeedRoot) return "absorbed";
  if (seedRootChanged) return "unaffected";
  return "rerooted";
}
