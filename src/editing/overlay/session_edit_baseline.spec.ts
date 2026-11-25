/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";
import {
  ChunkId,
  layerId,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import { SavedBaselineStore } from "#src/editing/adapters/saved_baseline_store.js";
import { sessionEditBaselineReader } from "#src/editing/overlay/session_edit_baseline.js";

const COORD: OverlayCoord = {
  layerId: layerId("seg"),
  resolution: ResolutionCtor.from([8, 8, 40]),
  chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
};

function chunkOf(...values: number[]): ReadonlyChunkVoxelBuffer {
  const bytes = Uint8Array.from(values);
  return { byteLength: bytes.byteLength, asView: () => bytes };
}

const SESSION_OPEN = chunkOf(0, 0, 0, 0);
const SAVED = chunkOf(7, 0, 0, 0);
const COMMITTED = chunkOf(9, 9, 0, 0);

describe("sessionEditBaselineReader", () => {
  it("prefers committed, then saved, then the session-open snapshot", async () => {
    expect(
      await sessionEditBaselineReader({
        committed: () => COMMITTED,
        saved: () => SAVED,
        sessionOpen: async () => SESSION_OPEN,
      })(COORD),
    ).toBe(COMMITTED);
    expect(
      await sessionEditBaselineReader({
        committed: () => undefined,
        saved: () => SAVED,
        sessionOpen: async () => SESSION_OPEN,
      })(COORD),
    ).toBe(SAVED);
    expect(
      await sessionEditBaselineReader({
        committed: () => undefined,
        saved: () => undefined,
        sessionOpen: async () => SESSION_OPEN,
      })(COORD),
    ).toBe(SESSION_OPEN);
  });

  it("is undefined when the session has no snapshot of the chunk", async () => {
    expect(
      await sessionEditBaselineReader({
        committed: () => undefined,
        saved: () => undefined,
        sessionOpen: () => undefined,
      })(COORD),
    ).toBeUndefined();
  });

  it("falls back to the session-open snapshot once the store evicts a saved chunk (TM-373)", async () => {
    const store = new SavedBaselineStore({ maxChunks: 100, maxBytes: 4 });
    const read = sessionEditBaselineReader({
      committed: () => undefined,
      saved: () => store.get("chunk"),
      sessionOpen: async () => SESSION_OPEN,
    });
    store.set("chunk", SAVED);
    expect(await read(COORD)).toBe(SAVED);

    store.set("another chunk", chunkOf(1, 1, 1, 1));
    expect(await read(COORD)).toBe(SESSION_OPEN);
  });
});
