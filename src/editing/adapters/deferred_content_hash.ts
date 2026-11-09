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
 * Content refs whose hash is computed when first read (TM-373).
 *
 * The library (0.1.2) builds a slot's content ref in
 * `EditOverlayStore.ensureContentRef`: a copy of the chunk plus an FNV-1a 64
 * hash of it, every time the slot was written since. It does so for every
 * stroke's before-image (`Edit.beginWrite`), every image-redo after-image
 * (`Edit.record`) and every dirty chunk at save/commit. On a 4096² uint64
 * chunk (128 MB) the copy takes ~5–20 ms and the hash 300–650 ms; only save
 * and commit verification ever read the hash.
 *
 * {@link deferContentHashing} replaces `ensureContentRef` on the session's
 * overlay instance (every one of those callers goes through it) with one that
 * copies at once, as the library does, and hashes on first read. Same bytes,
 * same algorithm (the library's own `fnv1aHashView`), so every hash compare
 * against `ownedRegionHash` holds; only the moment of hashing moves, from
 * every stroke to the save of that chunk.
 */

import {
  fnv1aHashView,
  type ChunkContentRef,
  type ChunkSlot,
  type ChunkVoxelBuffer,
  type EditOverlayStore,
  type ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";

/** Bytes the ref owns, served as the library's readonly buffer. */
class OwnedChunkBytes implements ReadonlyChunkVoxelBuffer {
  readonly byteLength: number;
  constructor(private readonly view: ChunkVoxelBuffer) {
    this.byteLength = view.byteLength;
  }
  asView(): ChunkVoxelBuffer {
    return this.view;
  }
}

/**
 * A class, not an object of closures, on purpose (TM-373): the bundler inlines
 * this module's single-use functions into `openSession`, and a closure made
 * there keeps that call's whole scope — the session itself — alive. Refs
 * outlive their session (committed and unconfirmed-save chunks keep them), so
 * a closure ref pinned every committed session with all its copies.
 */
class DeferredHashContentRef implements ChunkContentRef {
  readonly byteLength: number;
  private readonly bytes: OwnedChunkBytes;
  private cachedHash: string | undefined;

  constructor(captured: ChunkVoxelBuffer) {
    this.bytes = new OwnedChunkBytes(captured);
    this.byteLength = captured.byteLength;
  }

  get hash(): string {
    this.cachedHash ??= fnv1aHashView(this.bytes.asView());
    return this.cachedHash;
  }

  retain(): Promise<ReadonlyChunkVoxelBuffer> {
    return Promise.resolve(this.bytes);
  }
}

/**
 * A content ref over an immutable copy of `view`, hashed on first read. The
 * caller may keep writing `view`; the ref holds its own copy.
 */
export function contentRefWithDeferredHash(
  view: ChunkVoxelBuffer,
): ChunkContentRef {
  return new DeferredHashContentRef(view.slice() as ChunkVoxelBuffer);
}

/**
 * Make `overlay.ensureContentRef` build {@link contentRefWithDeferredHash}
 * refs. Same contract as the library method: a stale slot gets a new ref of
 * its current bytes and is marked valid; a valid slot returns its ref.
 * Install right after `EditSession.open`, before the first write.
 */
export function deferContentHashing(overlay: EditOverlayStore): void {
  overlay.ensureContentRef = (slot: ChunkSlot): ChunkContentRef => {
    if (!slot.contentRefValid) {
      slot.contentRef = contentRefWithDeferredHash(slot.data);
      slot.contentRefValid = true;
    }
    return slot.contentRef;
  };
}
