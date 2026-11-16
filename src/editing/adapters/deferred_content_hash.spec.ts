/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  collectDirtyChunks,
  contentRefFromBuffer,
  fnv1aHashView,
  type ChunkContentRef,
  type EditSession,
} from "@zettaai/edit-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contentRefWithDeferredHash,
  deferContentHashing,
} from "#src/editing/adapters/deferred_content_hash.js";
import {
  FAKE_LAYER,
  fakeChunkCoord,
  openFakeEditSession,
} from "#tests/editing/fakes/fake_edit_session_adapters.js";

// Pass-through spy on the exported hash: the library hashes through its own
// bundle-local copy, so only refs built here count on it. A ref whose `.hash`
// read bumps the spy was built by `contentRefWithDeferredHash`.
vi.mock("@zettaai/edit-session", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fnv1aHashView: vi.fn(actual.fnv1aHashView as typeof fnv1aHashView),
  };
});

const hashSpy = vi.mocked(fnv1aHashView);

const COORD = fakeChunkCoord();

async function openDeferredSession(): Promise<EditSession> {
  const session = await openFakeEditSession();
  deferContentHashing(session.overlay);
  return session;
}

/** One edit setting voxel `index` to `value`; `masked` records an image redo. */
async function paintVoxel(
  session: EditSession,
  index: number,
  value: number,
  masked = false,
): Promise<void> {
  const edit = session.beginEdit({
    description: "stroke",
    ...(masked
      ? {}
      : { redo: { kind: "replay" as const, reapply: async () => {} } }),
  });
  const slot = await edit.beginWrite(COORD);
  (slot.data as Uint8Array)[index] = value;
  edit.commitWrites(slot, { origin: [index, 0, 0], size: [1, 1, 1] });
  edit.record();
}

async function voxelAt(session: EditSession, index: number): Promise<number> {
  const view = (await session.overlay.read(COORD)).asView() as Uint8Array;
  return view[index]!;
}

/** True when `ref` was built here: reading its hash runs the exported hash. */
function isDeferred(ref: ChunkContentRef): boolean {
  const before = hashSpy.mock.calls.length;
  void ref.hash;
  return hashSpy.mock.calls.length === before + 1;
}

afterEach(() => {
  hashSpy.mockClear();
});

describe("contentRefWithDeferredHash", () => {
  it("copies at once and hashes only when the hash is read", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const ref = contentRefWithDeferredHash(source);
    source[0] = 99;
    expect(hashSpy).not.toHaveBeenCalled();
    const captured = (await ref.retain()).asView() as Uint8Array;
    expect(captured).not.toBe(source);
    expect(Array.from(captured)).toEqual([1, 2, 3, 4]);
    expect(ref.byteLength).toBe(4);
  });

  it("gives the library's own hash of the same bytes, computed once", () => {
    const bytes = new BigUint64Array([5n, 6n, 7n]);
    const ref = contentRefWithDeferredHash(bytes);
    const libraryHash = contentRefFromBuffer(bytes).hash;
    expect(ref.hash).toBe(libraryHash);
    expect(ref.hash).toBe(libraryHash);
    expect(hashSpy).toHaveBeenCalledTimes(1);
  });
});

describe("deferContentHashing on a library 0.1.2 session", () => {
  it("a stroke's before-image is copied but not hashed", async () => {
    const session = await openDeferredSession();
    await paintVoxel(session, 0, 7);
    await paintVoxel(session, 1, 9);
    expect(hashSpy).not.toHaveBeenCalled();

    const undone = await session.undo();
    const beforeRef = undone!.chunkDeltas[0]!.beforeRef!;
    expect(isDeferred(beforeRef)).toBe(true);
    const beforeBytes = (await beforeRef.retain()).asView();
    expect(beforeBytes[0]).toBe(7);
    expect(beforeBytes[1]).toBe(0);
    expect(beforeRef.hash).toBe(contentRefFromBuffer(beforeBytes).hash);
  });

  it("a masked stroke's after-image is copied but not hashed", async () => {
    const session = await openDeferredSession();
    await paintVoxel(session, 0, 7, true);
    expect(hashSpy).not.toHaveBeenCalled();

    const undone = await session.undo();
    const afterRef = undone!.chunkDeltas[0]!.afterRef!;
    expect(isDeferred(afterRef)).toBe(true);
    expect((await afterRef.retain()).asView()[0]).toBe(7);
  });

  it("dirty chunks for save carry a deferred ref with the library's hash", async () => {
    const session = await openDeferredSession();
    await paintVoxel(session, 3, 4);
    const [chunk] = await collectDirtyChunks(session.overlay);
    expect(chunk).toBeDefined();
    expect(isDeferred(chunk!.contentRef)).toBe(true);
    expect(chunk!.contentRef.hash).toBe(
      contentRefFromBuffer(chunk!.bytes.asView()).hash,
    );
    expect(chunk!.bytes.asView()[3]).toBe(4);
  });

  it("undo and redo restore the right bytes", async () => {
    const session = await openDeferredSession();
    await paintVoxel(session, 0, 7, true);
    await paintVoxel(session, 1, 9, true);

    await session.undo();
    expect(await voxelAt(session, 0)).toBe(7);
    expect(await voxelAt(session, 1)).toBe(0);
    await session.undo();
    expect(await voxelAt(session, 0)).toBe(0);
    expect(session.dirty.isLayerDirty(FAKE_LAYER)).toBe(false);

    await session.redo();
    await session.redo();
    expect(await voxelAt(session, 0)).toBe(7);
    expect(await voxelAt(session, 1)).toBe(9);
  });
});
