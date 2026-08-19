export function isStaleRoot(
  candidateRoot: bigint,
  oldRoots: ReadonlySet<bigint>,
): boolean {
  return oldRoots.has(candidateRoot);
}
