/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Edit, EditSession, OverlayCoord } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import { deferContentHashing } from "#src/editing/adapters/deferred_content_hash.js";
import {
  boundHistoryReplayScans,
  writtenBox,
} from "#src/editing/adapters/history_replay_hints.js";
import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import {
  notePaintedSubBox,
  takePaintedSubBox,
} from "#src/editing/overlay/painted_subbox_registry.js";
import {
  FAKE_CHUNK_SIZE,
  FAKE_LAYER,
  fakeChunkCoord,
  openFakeEditSession,
} from "#tests/editing/fakes/fake_edit_session_adapters.js";

const [CHUNK_X, CHUNK_Y] = FAKE_CHUNK_SIZE;

interface CommitSeen {
  readonly chunkId: string;
  /** The hint the mirror would take for this commit, if any. */
  readonly hint: ChunkVoxelBox | undefined;
}

/**
 * Open a session with the hooks installed and record, per `chunk-changed`, the
 * hint a mirror would take — the same synchronous `takePaintedSubBox` call
 * `PatchMirror` makes.
 */
async function openWatchedSession(
  options: { deferHashing?: boolean } = {},
): Promise<{
  session: EditSession;
  commits: CommitSeen[];
}> {
  const session = await openFakeEditSession();
  // Same order as `EditSessionHost.openSession`.
  if (options.deferHashing === true) deferContentHashing(session.overlay);
  boundHistoryReplayScans(session);
  const commits: CommitSeen[] = [];
  session.dirty.on("chunk-changed", ({ coord }) => {
    commits.push({
      chunkId: coord.chunkId,
      hint: takePaintedSubBox(coord.layerId, coord.resolution, coord.chunkId),
    });
  });
  return { session, commits };
}

/** One edit painting `box` (chunk-local, inclusive) with `value`. */
/** Fill `box` of `coord` with `value` inside `edit` and commit it. */
async function writeBox(
  edit: Edit,
  coord: OverlayCoord,
  box: ChunkVoxelBox,
  value: number,
): Promise<void> {
  const slot = await edit.beginWrite(coord);
  const view = slot.data as Uint8Array;
  for (let z = box.z0; z <= box.z1; z++) {
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        view[(z * CHUNK_Y + y) * CHUNK_X + x] = value;
      }
    }
  }
  edit.commitWrites(slot, {
    origin: [box.x0, box.y0, box.z0],
    size: [box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, box.z1 - box.z0 + 1],
  });
}

/**
 * One edit painting `box` (chunk-local, inclusive) with `value`. Unmasked
 * (`masked: false`) records a replay redo that repaints the box, like the
 * brush; otherwise an image redo, like a masked stroke.
 */
async function paintBox(
  session: EditSession,
  box: ChunkVoxelBox,
  value: number,
  options: { coord?: OverlayCoord; masked?: boolean; discard?: boolean } = {},
): Promise<void> {
  const coord = options.coord ?? fakeChunkCoord();
  const edit = session.beginEdit({
    description: "stroke",
    ...(options.masked === false
      ? {
          redo: {
            kind: "replay" as const,
            reapply: (replay: Edit) => writeBox(replay, coord, box, value),
          },
        }
      : {}),
  });
  await writeBox(edit, coord, box, value);
  if (options.discard === true) await edit.discard();
  else edit.record();
}

function box(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): ChunkVoxelBox {
  return { x0, y0, z0, x1, y1, z1 };
}

async function chunkBytes(
  session: EditSession,
  coord: OverlayCoord = fakeChunkCoord(),
): Promise<Uint8Array> {
  return (await session.overlay.read(coord)).asView().slice() as Uint8Array;
}

/** Every voxel that differs between `before` and `after` lies inside `hint`. */
function changesInside(
  before: Uint8Array,
  after: Uint8Array,
  hint: ChunkVoxelBox,
): boolean {
  for (let index = 0; index < before.length; index++) {
    if (before[index] === after[index]) continue;
    const x = index % CHUNK_X;
    const y = Math.floor(index / CHUNK_X) % CHUNK_Y;
    const z = Math.floor(index / (CHUNK_X * CHUNK_Y));
    const inside =
      x >= hint.x0 &&
      x <= hint.x1 &&
      y >= hint.y0 &&
      y <= hint.y1 &&
      z >= hint.z0 &&
      z <= hint.z1;
    if (!inside) return false;
  }
  return true;
}

describe("writtenBox", () => {
  it("turns a commit's origin + size into an inclusive chunk-local box", () => {
    expect(writtenBox({ origin: [2, 3, 4], size: [1, 5, 2] })).toEqual(
      box(2, 3, 4, 2, 7, 5),
    );
  });
});

describe("boundHistoryReplayScans on a library 0.1.2 session", () => {
  it("bounds an undo to the undone edit's own box", async () => {
    const { session, commits } = await openWatchedSession();
    await paintBox(session, box(1, 1, 0, 2, 2, 0), 7);
    await paintBox(session, box(5, 3, 1, 6, 4, 1), 9);
    commits.length = 0;

    await session.undo();
    expect(commits).toEqual([
      { chunkId: fakeChunkCoord().chunkId, hint: box(5, 3, 1, 6, 4, 1) },
    ]);
  });

  it("a small stroke after a large one undoes within the small box", async () => {
    const { session, commits } = await openWatchedSession();
    await paintBox(session, box(0, 0, 0, 15, 15, 15), 1, { masked: false });
    await paintBox(session, box(7, 7, 7, 8, 8, 8), 2);
    commits.length = 0;

    await session.undo();
    expect(commits.map((commit) => commit.hint)).toEqual([
      box(7, 7, 7, 8, 8, 8),
    ]);
  });

  it("an undo back to baseline covers every commit to the chunk", async () => {
    const { session, commits } = await openWatchedSession();
    await paintBox(session, box(1, 1, 0, 2, 2, 0), 7);
    await paintBox(session, box(5, 3, 1, 6, 4, 1), 9);
    await session.undo();
    commits.length = 0;

    await session.undo();
    expect(commits.map((commit) => commit.hint)).toEqual([
      box(1, 1, 0, 6, 4, 1),
    ]);
  });

  it("bounds an image redo to the redone edit's box", async () => {
    const { session, commits } = await openWatchedSession();
    await paintBox(session, box(4, 4, 2, 5, 5, 2), 3);
    commits.length = 0;

    await session.undo();
    await session.redo();
    expect(commits.map((commit) => commit.hint)).toEqual([
      box(4, 4, 2, 5, 5, 2),
      box(4, 4, 2, 5, 5, 2),
    ]);
  });

  it("covers the edit being discarded", async () => {
    const { session, commits } = await openWatchedSession();
    await paintBox(session, box(0, 0, 0, 1, 1, 0), 2);
    commits.length = 0;
    await paintBox(session, box(9, 9, 3, 10, 10, 3), 4, { discard: true });

    // The discarded write itself, then its restore bounded to that write.
    expect(commits.map((commit) => commit.hint)).toEqual([
      undefined,
      box(9, 9, 3, 10, 10, 3),
    ]);
  });

  it("keeps commit logs per chunk", async () => {
    const { session, commits } = await openWatchedSession();
    await paintBox(session, box(0, 0, 0, 0, 0, 0), 1);
    await paintBox(session, box(8, 8, 8, 9, 9, 9), 1, {
      coord: fakeChunkCoord(1),
    });
    commits.length = 0;

    await session.undo();
    expect(commits).toEqual([
      { chunkId: fakeChunkCoord(1).chunkId, hint: box(8, 8, 8, 9, 9, 9) },
    ]);
  });

  it("leaves a paint write's own hint alone and adds no hint to it", async () => {
    const { session, commits } = await openWatchedSession();
    const coord = fakeChunkCoord();
    const paintHint = box(3, 3, 0, 3, 3, 0);
    notePaintedSubBox(
      coord.layerId,
      coord.resolution,
      coord.chunkId,
      paintHint,
    );
    await paintBox(session, box(3, 3, 0, 3, 3, 0), 5);
    await paintBox(session, box(6, 6, 0, 6, 6, 0), 5);

    expect(commits.map((commit) => commit.hint)).toEqual([
      paintHint,
      undefined,
    ]);
  });

  it("leaves no hint behind after a restore", async () => {
    const { session } = await openWatchedSession();
    const coord = fakeChunkCoord();
    await paintBox(session, box(1, 1, 1, 1, 1, 1), 8);
    await session.undo();
    await session.redo();
    expect(
      takePaintedSubBox(coord.layerId, coord.resolution, coord.chunkId),
    ).toBeUndefined();
  });

  it("every voxel an undo, redo or discard changes lies inside its hint", async () => {
    const { session, commits } = await openWatchedSession();
    const strokes = [
      box(0, 0, 0, 3, 2, 1),
      box(10, 1, 4, 15, 6, 4),
      box(2, 12, 15, 4, 15, 15),
      box(7, 7, 7, 8, 8, 8),
    ];
    for (const [index, stroke] of strokes.entries()) {
      await paintBox(session, stroke, index + 1, { masked: index % 2 === 0 });
    }

    const checkRestore = async (restore: () => Promise<unknown>) => {
      const before = await chunkBytes(session);
      commits.length = 0;
      await restore();
      const after = await chunkBytes(session);
      expect(commits).toHaveLength(1);
      const hint = commits[0]!.hint;
      expect(hint).toBeDefined();
      expect(changesInside(before, after, hint!)).toBe(true);
    };

    await checkRestore(() => session.undo());
    await checkRestore(() => session.undo());
    await checkRestore(() => session.redo()); // image redo (masked stroke)
    await checkRestore(() => session.undo());
    await checkRestore(() => session.undo());
    await checkRestore(() => session.undo()); // back to baseline
    expect(session.dirty.isLayerDirty(FAKE_LAYER)).toBe(false);
  });

  it("with the host's hooks, every restore of a long random history stays inside its hint", async () => {
    const { session, commits } = await openWatchedSession({
      deferHashing: true,
    });
    // Deterministic LCG, so a failure reproduces.
    let seed = 12345;
    const next = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const randomBox = (): ChunkVoxelBox => {
      const x0 = next(CHUNK_X);
      const y0 = next(CHUNK_Y);
      const z0 = next(16);
      return box(
        x0,
        y0,
        z0,
        Math.min(CHUNK_X - 1, x0 + next(6)),
        Math.min(CHUNK_Y - 1, y0 + next(6)),
        Math.min(15, z0 + next(3)),
      );
    };

    let restores = 0;
    for (let step = 0; step < 300; step++) {
      const action = next(10);
      const before = await chunkBytes(session);
      commits.length = 0;
      if (action < 5) {
        await paintBox(session, randomBox(), 1 + next(200), {
          masked: next(2) === 0,
        });
        continue;
      }
      if (action === 5) {
        await paintBox(session, randomBox(), 1 + next(200), {
          discard: true,
        });
      } else if (action < 8) {
        await session.undo();
      } else {
        await session.redo();
      }
      const after = await chunkBytes(session);
      for (const commit of commits) {
        if (commit.hint === undefined) continue; // the discarded write itself
        restores += 1;
        expect(changesInside(before, after, commit.hint)).toBe(true);
      }
    }
    expect(restores).toBeGreaterThan(50);
  });
});
