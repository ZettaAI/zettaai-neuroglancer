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
 * @file Which of this save's chunks the remote moved under us since we read
 * them — the check that has to happen BEFORE the bytes go out.
 *
 * A session reads a chunk at open, the user paints for minutes or hours, and
 * the save POSTs an absolute payload for the owned sub-box. If another
 * annotator wrote those voxels in between, that payload silently reinstates our
 * stale copy over their work. Per-chunk compare-and-swap in the backend does
 * NOT catch this: the generation it compares is the one it read microseconds
 * earlier inside its own read-patch-write, not the one this browser read at
 * cutout time. Every CAS succeeds on the first attempt and the POST returns
 * 200. Painting layers have no object versioning, so what is overwritten is
 * gone.
 *
 * The comparison is `retained baseline` vs `remote now`, and it is made through
 * the SAME {@link ChunkOwnedGeometry} the write path uses. That is not an
 * optimisation — it is the only granularity that works. Task bboxes come from
 * sampling and do not land on the chunk grid, so a boundary chunk is shared by
 * two tasks *because* their regions do not overlap. Comparing whole chunks (or
 * comparing storage generations, which are per chunk object) reports a conflict
 * every time a neighbour saves, which is constantly and always wrongly. See the
 * header of `owned_chunk_write.ts` — the verifier hit this exact wall first.
 *
 * This module is deliberately I/O-free. {@link classifyAgainstRetainedBaseline}
 * is the whole decision and is a pure function of three buffers;
 * {@link scanForStaleBaselines} only sequences reads and collects. That keeps
 * the part that can be wrong testable without a GL context, a chunk source, or
 * a network.
 */

import type { ReadonlyChunkVoxelBuffer } from "@zettaai/edit-session";

import type { OwnedChunkWrite } from "#src/editing/region/owned_chunk_write.js";
import { ownedRegionHash } from "#src/editing/region/owned_chunk_write.js";

/**
 * Fresh reads issued at once while the user waits on a save. Sized to match
 * `SAVE_UPLOAD_CONCURRENCY`, for the same reason it is 5 — the scan runs
 * strictly before the uploads, so the two never contend for the same slots and
 * one budget describes the backend's tolerance for both.
 */
export const STALE_BASELINE_SCAN_CONCURRENCY = 5;

/** Why a chunk could not be compared at all. */
export type UncomparableReason =
  /**
   * No retained copy of what this session last observed as remote truth. The
   * host's saved-baseline store is bounded, so a session that dirties more
   * chunks than it holds can evict one. Never treated as "unchanged": that
   * would reintroduce exactly the silent overwrite this module exists to catch.
   */
  | "no-retained-baseline"
  /** The `(layer, resolution)` no longer resolves, or the fresh read failed. */
  | "remote-unreadable";

/** A chunk whose remote bytes no longer match what this session read. */
export interface DivergedChunk {
  readonly write: OwnedChunkWrite;
  /** Hash of the owned sub-box as this session last observed it remotely. */
  readonly baselineHash: string;
  /** Hash of the owned sub-box as the remote holds it now. */
  readonly remoteHash: string;
}

export interface UncomparableChunk {
  readonly write: OwnedChunkWrite;
  readonly reason: UncomparableReason;
}

/** Per-chunk verdict. Exactly one of these holds for every scanned chunk. */
export type ChunkComparison =
  /** Remote still holds what we read. Writing our payload loses nothing. */
  | { readonly kind: "unchanged" }
  /**
   * Remote already holds the exact bytes this save would write. Reached by a
   * retry of a partially-applied save, and by two people painting the same
   * result. Writing again is a no-op, so this is NOT a conflict — classifying
   * it as one would make every retry of a partial save raise a conflict for
   * each chunk that already landed.
   */
  | { readonly kind: "already-applied" }
  | {
      readonly kind: "diverged";
      readonly baselineHash: string;
      readonly remoteHash: string;
    }
  | { readonly kind: "uncomparable"; readonly reason: UncomparableReason };

export interface StaleBaselineScan {
  readonly diverged: readonly DivergedChunk[];
  readonly uncomparable: readonly UncomparableChunk[];
  readonly unchangedCount: number;
  readonly alreadyAppliedCount: number;
}

/** Reads the scan needs, injected so the decision stays testable in isolation. */
export interface RemoteBaselineReaders {
  /**
   * The remote's current bytes for this chunk, decoded the same way the
   * baseline read decodes them. `undefined` when the source no longer resolves.
   */
  readonly readRemote: (
    write: OwnedChunkWrite,
    signal?: AbortSignal,
  ) => Promise<ReadonlyChunkVoxelBuffer | undefined>;
  /**
   * What this session last observed as remote truth for this chunk: the bytes
   * it last successfully saved, or failing that the baseline it opened with.
   * `undefined` when neither is retained.
   */
  readonly readRetainedBaseline: (
    write: OwnedChunkWrite,
    signal?: AbortSignal,
  ) => Promise<ReadonlyChunkVoxelBuffer | undefined>;
}

/**
 * The whole decision, as a pure function.
 *
 * `already-applied` is tested before `diverged` on purpose: when the remote
 * already equals our payload, the baseline is irrelevant and the write is a
 * no-op. Checking divergence first would flag every already-landed chunk of a
 * retried partial save.
 */
export function classifyAgainstRetainedBaseline(
  write: OwnedChunkWrite,
  remote: ReadonlyChunkVoxelBuffer | undefined,
  retainedBaseline: ReadonlyChunkVoxelBuffer | undefined,
): ChunkComparison {
  if (remote === undefined) {
    return { kind: "uncomparable", reason: "remote-unreadable" };
  }
  const remoteHash = ownedRegionHash(remote.asView(), write.owned);
  if (remoteHash === write.owned.hash) return { kind: "already-applied" };

  if (retainedBaseline === undefined) {
    return { kind: "uncomparable", reason: "no-retained-baseline" };
  }
  const baselineHash = ownedRegionHash(retainedBaseline.asView(), write.owned);
  if (baselineHash === remoteHash) return { kind: "unchanged" };
  return { kind: "diverged", baselineHash, remoteHash };
}

/**
 * Classify every chunk this save would write, bounded to
 * {@link STALE_BASELINE_SCAN_CONCURRENCY} fresh reads in flight.
 *
 * A read that throws is recorded as `remote-unreadable` rather than failing the
 * scan: one unreadable chunk should surface as one unresolved chunk, not
 * abandon the conflict check for the whole save. An aborted signal stops
 * launching further reads; whatever settled is returned.
 */
export async function scanForStaleBaselines(
  writes: readonly OwnedChunkWrite[],
  readers: RemoteBaselineReaders,
  signal: AbortSignal,
  concurrency: number = STALE_BASELINE_SCAN_CONCURRENCY,
): Promise<StaleBaselineScan> {
  const diverged: DivergedChunk[] = [];
  const uncomparable: UncomparableChunk[] = [];
  let unchangedCount = 0;
  let alreadyAppliedCount = 0;

  const record = (
    write: OwnedChunkWrite,
    comparison: ChunkComparison,
  ): void => {
    switch (comparison.kind) {
      case "unchanged":
        unchangedCount++;
        return;
      case "already-applied":
        alreadyAppliedCount++;
        return;
      case "diverged":
        diverged.push({
          write,
          baselineHash: comparison.baselineHash,
          remoteHash: comparison.remoteHash,
        });
        return;
      case "uncomparable":
        uncomparable.push({ write, reason: comparison.reason });
        return;
    }
  };

  await runOverChunks(writes, concurrency, signal, async (write) => {
    record(write, await classifyOneChunk(write, readers, signal));
  });

  return { diverged, uncomparable, unchangedCount, alreadyAppliedCount };
}

async function classifyOneChunk(
  write: OwnedChunkWrite,
  readers: RemoteBaselineReaders,
  signal: AbortSignal,
): Promise<ChunkComparison> {
  let remote: ReadonlyChunkVoxelBuffer | undefined;
  try {
    remote = await readers.readRemote(write, signal);
  } catch {
    return { kind: "uncomparable", reason: "remote-unreadable" };
  }
  let retainedBaseline: ReadonlyChunkVoxelBuffer | undefined;
  try {
    retainedBaseline = await readers.readRetainedBaseline(write, signal);
  } catch {
    return { kind: "uncomparable", reason: "no-retained-baseline" };
  }
  return classifyAgainstRetainedBaseline(write, remote, retainedBaseline);
}

/**
 * Run `worker` over `writes` with at most `limit` concurrent invocations,
 * resolving once every item has settled. Mirrors the bounded loops in
 * `session_chunk_preloader.ts` and `http_save_backend.ts`; `worker` never
 * rejects, so there is no partial-failure mode to unwind.
 */
async function runOverChunks(
  writes: readonly OwnedChunkWrite[],
  limit: number,
  signal: AbortSignal,
  worker: (write: OwnedChunkWrite) => Promise<void>,
): Promise<void> {
  let next = 0;
  const launch = async (): Promise<void> => {
    while (next < writes.length && !signal.aborted) {
      await worker(writes[next++]);
    }
  };
  const runnerCount = Math.min(limit, writes.length);
  const runners: Promise<void>[] = [];
  for (let i = 0; i < runnerCount; ++i) {
    runners.push(launch());
  }
  await Promise.all(runners);
}
