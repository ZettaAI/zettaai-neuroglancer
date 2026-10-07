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
 * @file Which resident chunks a mid-session refetch is allowed to evict.
 *
 * Refetching exists so a colleague's work in a chunk NOBODY HERE PAINTED stops
 * being stale — before it, a chunk kept whatever bytes the session read at
 * open until the session ended. Those chunks carry no GPU patch, which is
 * exactly what makes them safe to evict: there is nothing of this session's on
 * top of them to disagree with the bytes that come back.
 *
 * A patched chunk is never evicted, and the reasoning is worth keeping because
 * two separate regressions came from getting it wrong. The patch draws OVER
 * the datasource chunk and its per-voxel mask is derived from the datasource
 * bytes, so refetching under it leaves the two halves of the composite built
 * from different versions: the patch went on painting this session's older
 * values over a colleague's newer ones, which looked like the colleague's work
 * had vanished. Dropping the patch instead is worse, because "this session put
 * something here" does not mean "storage has it": the bytes may be dirty,
 * saved, or committed in memory only, and dropping the patch of the last two
 * erased painting that existed nowhere else on screen.
 *
 * So the rule is the narrow one: evict only what this session has not touched.
 * A patched chunk is reconciled at session exit, as it always was.
 */

import type { ChunkKey } from "#src/editing/local_patch_source.js";

/**
 * The resident chunks to evict, given every resident chunk and the ones this
 * session has a patch for. Both sides are keyed as {@link chunkGridKey} keys
 * them.
 */
export function chunksSafeToRefetch(
  resident: Iterable<ChunkKey>,
  patched: ReadonlySet<ChunkKey>,
): ChunkKey[] {
  const safe: ChunkKey[] = [];
  for (const key of resident) {
    if (!patched.has(key)) safe.push(key);
  }
  return safe;
}
