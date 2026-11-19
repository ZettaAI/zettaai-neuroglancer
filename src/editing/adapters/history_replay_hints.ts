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
 * Bounded mirror passes for undo, redo and discard (TM-373).
 *
 * The library restores a chunk for undo / image redo / `Edit.discard()` by
 * copying a whole history image into the slot and committing the WHOLE chunk
 * (`EditSession.restoreChunkContent` → `overlay.commitWrites(slot, fullRegion)`).
 * That commit carries no painted-sub-box hint, so the mirror rescans the whole
 * chunk: on a 4096² uint64 chunk a full baseline decode, 0.4–1.1 s per undo.
 *
 * A restore brings back a content ref: the chunk's bytes at the moment the ref
 * was taken (`ensureContentRef` only hands out a ref equal to the slot's
 * current bytes), or the baseline for `null`. Since that moment the chunk
 * changed only through commits, and each commit changed only voxels inside a
 * known box: a write inside its `written` subregion, an earlier restore inside
 * its own hint. So the restored bytes differ from the current ones only inside
 * the union of the boxes of the commits made since the ref was taken. That
 * union is a superset of what the restore changes — exactly what a
 * painted-sub-box hint promises (`painted_subbox_registry.ts`) — so a mirror
 * pass bounded to it gives the same state as a full scan. For an undo it is
 * the undone edit's own boxes, not the whole session's.
 *
 * {@link boundHistoryReplayScans} keeps, per chunk, a log of commit boxes with a
 * running sequence number (all commits go through `overlay.commitWrites` on the
 * instance), notes the sequence at which each ref was handed out (through
 * `overlay.ensureContentRef`), and files the union as the hint of a commit that
 * comes from `restoreChunkContent` on that chunk. A ref it never saw (the
 * baseline) counts from the chunk's first commit.
 *
 * `restoreChunkContent` is not public API. If a library version drops it, the
 * restore commits are simply not recognised and keep the full scan, as before.
 */

import type {
  ChunkContentRef,
  ChunkSlot,
  ChunkSubregion,
  EditSession,
  OverlayCoord,
} from "@zettaai/edit-session";

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import {
  notePaintedSubBox,
  takePaintedSubBox,
} from "#src/editing/overlay/painted_subbox_registry.js";

/**
 * The library-internal restore step of undo / image redo / `Edit.discard()`
 * (0.1.2: `EditSession.restoreChunkContent`, called through the instance).
 */
interface ContentRefRestore {
  restoreChunkContent(
    coord: OverlayCoord,
    ref: ChunkContentRef | null,
  ): Promise<void>;
}

/** One commit to a chunk: its sequence number and a box holding its changes. */
interface CommitRecord {
  readonly sequence: number;
  readonly box: ChunkVoxelBox;
}

/** What one chunk has seen this session. */
interface ChunkCommitLog {
  /** Sequence number of the latest commit; 0 before the first. */
  latest: number;
  readonly commits: CommitRecord[];
}

/** A restore of this chunk in flight, and the ref it brings back. */
interface RestoreInFlight {
  readonly ref: ChunkContentRef | null;
}

/** The chunk-local inclusive box a commit's `written` subregion covers. */
export function writtenBox(written: ChunkSubregion): ChunkVoxelBox {
  const [originX, originY, originZ] = written.origin;
  const [sizeX, sizeY, sizeZ] = written.size;
  return {
    x0: originX,
    y0: originY,
    z0: originZ,
    x1: originX + sizeX - 1,
    y1: originY + sizeY - 1,
    z1: originZ + sizeZ - 1,
  };
}

/** The smallest box containing every box in `boxes`, or undefined if none. */
function unionOf(boxes: Iterable<ChunkVoxelBox>): ChunkVoxelBox | undefined {
  let union: ChunkVoxelBox | undefined;
  for (const box of boxes) {
    union =
      union === undefined
        ? { ...box }
        : {
            x0: Math.min(union.x0, box.x0),
            y0: Math.min(union.y0, box.y0),
            z0: Math.min(union.z0, box.z0),
            x1: Math.max(union.x1, box.x1),
            y1: Math.max(union.y1, box.y1),
            z1: Math.max(union.z1, box.z1),
          };
  }
  return union;
}

function chunkKey(coord: OverlayCoord): string {
  return `${coord.layerId}|${coord.resolution}|${coord.chunkId}`;
}

/** Boxes of the commits made after `sequence`. */
function* boxesAfter(
  log: ChunkCommitLog,
  sequence: number,
): IterableIterator<ChunkVoxelBox> {
  for (const commit of log.commits) {
    if (commit.sequence > sequence) yield commit.box;
  }
}

/**
 * Install the commit log and the restore hints on `session`. Call right after
 * `EditSession.open`, before the first write: a commit the log did not see
 * would be missing from the hints.
 */
export function boundHistoryReplayScans(session: EditSession): void {
  const overlay = session.overlay;
  const logs = new Map<string, ChunkCommitLog>();
  const refTakenAt = new WeakMap<ChunkContentRef, number>();
  const restoresInFlight = new Map<string, RestoreInFlight[]>();

  const logOf = (key: string): ChunkCommitLog => {
    let log = logs.get(key);
    if (log === undefined) {
      log = { latest: 0, commits: [] };
      logs.set(key, log);
    }
    return log;
  };

  const ensureContentRef = overlay.ensureContentRef.bind(overlay);
  overlay.ensureContentRef = (slot: ChunkSlot): ChunkContentRef => {
    const ref = ensureContentRef(slot);
    // A ref handed out now equals the slot's bytes now.
    if (!refTakenAt.has(ref)) refTakenAt.set(ref, logOf(chunkKey(slot)).latest);
    return ref;
  };

  const commitWrites = overlay.commitWrites.bind(overlay);
  overlay.commitWrites = (slot: ChunkSlot, written: ChunkSubregion): void => {
    const key = chunkKey(slot);
    const log = logOf(key);
    const restore = restoresInFlight.get(key)?.at(-1);
    if (restore === undefined) {
      log.latest += 1;
      log.commits.push({ sequence: log.latest, box: writtenBox(written) });
      commitWrites(slot, written);
      return;
    }
    const since = restore.ref === null ? 0 : (refTakenAt.get(restore.ref) ?? 0);
    // Nothing committed since the ref was taken: the restore changes no voxel,
    // so any box is a superset; one voxel keeps the pass trivial.
    const hint = unionOf(boxesAfter(log, since)) ?? {
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 0,
      y1: 0,
      z1: 0,
    };
    log.latest += 1;
    log.commits.push({ sequence: log.latest, box: hint });
    notePaintedSubBox(slot.layerId, slot.resolution, slot.chunkId, hint);
    try {
      commitWrites(slot, written);
    } finally {
      // Drop the hint if no `chunk-changed` consumed it, as the paint path does.
      takePaintedSubBox(slot.layerId, slot.resolution, slot.chunkId);
    }
  };

  const restorable = session as unknown as Partial<ContentRefRestore>;
  const libraryRestore = restorable.restoreChunkContent;
  if (typeof libraryRestore !== "function") return;
  restorable.restoreChunkContent = async (coord, ref) => {
    const key = chunkKey(coord);
    const restores = restoresInFlight.get(key) ?? [];
    const restore: RestoreInFlight = { ref };
    restores.push(restore);
    restoresInFlight.set(key, restores);
    try {
      await libraryRestore.call(session, coord, ref);
    } finally {
      restores.splice(restores.indexOf(restore), 1);
      if (restores.length === 0) restoresInFlight.delete(key);
    }
  };
}
