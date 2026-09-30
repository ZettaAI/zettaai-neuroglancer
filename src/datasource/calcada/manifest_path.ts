export function buildManifestPath(
  objectId: bigint,
  lod: number,
  branchId: number,
): string {
  let manifestPath = `/manifest/${objectId}:${lod}?verify=1&prepend_seg_ids=1`;
  if (branchId && branchId > 0) {
    manifestPath += `&branch_id=${branchId}`;
  }
  return manifestPath;
}
