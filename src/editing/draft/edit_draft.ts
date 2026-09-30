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
 * @file A recoverable copy of unsaved paint, and the identity that lets a
 * later session find it again.
 *
 * Until a save lands, an edit session's paint exists only in this tab's
 * memory: the overlay holds it, and `commit` moves it to another in-memory
 * store in the same process. A refresh, a crash, or a closed tab takes an
 * hour of tracing with it, and no conflict has to be involved.
 *
 * A draft is that paint written somewhere it survives the tab. It exists for
 * two moments. The first is the one this feature was asked for: before an
 * OVERWRITE, because painting layers have no object versioning and the write
 * cannot be undone — the draft is what makes "I chose wrong" recoverable.
 * The second is ordinary crash insurance, which the same record supports.
 *
 * IDENTITY. A draft has to be findable by a session that did not write it —
 * the tab that crashed is gone, along with its session id. So the id is
 * derived from what the new session can know about itself: which layers at
 * which resolutions, over which region. Two sessions over the same work find
 * the same draft; two over different regions never collide.
 */

import { fnv1aHash64 } from "@zettaai/edit-session";

/** Why the draft was taken. Shown when offering it back. */
export type DraftReason = "before-overwrite" | "periodic";

/** One chunk's whole-chunk voxel bytes, as they stood in the overlay. */
export interface DraftChunk {
  readonly layerId: string;
  /** Canonical resolution string, e.g. `"8x8x40"`. For display and grouping. */
  readonly resolution: string;
  /**
   * The same resolution as physical voxel size. Stored alongside the string
   * so a restore rebuilds the branded `Resolution` through the library's own
   * `Resolution.from`, rather than re-implementing its encoding by parsing
   * the string back apart.
   */
  readonly voxelSizeNm: readonly [number, number, number];
  readonly chunkId: string;
  readonly bytes: Uint8Array;
}

/** A session's unsaved paint, plus enough context to offer it back. */
export interface EditDraft {
  readonly draftId: string;
  /** Wall-clock ms, so the offer can say how old the draft is. */
  readonly savedAt: number;
  readonly reason: DraftReason;
  /** `layerId|resolution` pairs the draft covers, for the offer text. */
  readonly scopes: readonly string[];
  readonly chunks: readonly DraftChunk[];
}

/** What `list()` returns: everything but the bytes. */
export type EditDraftSummary = Omit<EditDraft, "chunks"> & {
  readonly chunkCount: number;
};

export interface DraftScope {
  readonly layerId: string;
  readonly resolution: string;
}

/**
 * A stable id for the work a session is doing.
 *
 * Sorted so that the order layers happen to be listed in cannot produce two
 * ids for one region, and hashed so the id stays a short key rather than a
 * sprawling composite. Collisions across genuinely different regions are the
 * only failure mode that matters, and 64-bit FNV over a canonical string is
 * far past what the handful of drafts a user accumulates needs.
 */
export function draftIdForRegion(
  scopes: readonly DraftScope[],
  regionStart: readonly [number, number, number],
  regionEnd: readonly [number, number, number],
): string {
  const canonicalScopes = scopes
    .map((scope) => `${scope.layerId}|${scope.resolution}`)
    .sort()
    .join(",");
  const canonical = `${canonicalScopes}@${regionStart.join(",")}:${regionEnd.join(",")}`;
  return fnv1aHash64(new TextEncoder().encode(canonical));
}

/** Drop the bytes, keep everything a chooser needs. */
export function summarizeDraft(draft: EditDraft): EditDraftSummary {
  const { chunks, ...rest } = draft;
  return { ...rest, chunkCount: chunks.length };
}

/** Total voxel bytes a draft holds — the number a quota decision needs. */
export function draftByteLength(draft: EditDraft): number {
  let total = 0;
  for (const chunk of draft.chunks) total += chunk.bytes.byteLength;
  return total;
}
