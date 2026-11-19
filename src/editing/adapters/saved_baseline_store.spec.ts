/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ReadonlyChunkVoxelBuffer } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SAVED_BASELINE_LIMITS,
  SavedBaselineStore,
} from "#src/editing/adapters/saved_baseline_store.js";

function chunkOf(byteLength: number): ReadonlyChunkVoxelBuffer {
  const bytes = new Uint8Array(byteLength);
  return { byteLength, asView: () => bytes };
}

function keysIn(store: SavedBaselineStore, keys: string[]): string[] {
  return keys.filter((key) => store.get(key) !== undefined);
}

describe("SavedBaselineStore", () => {
  it("keeps the buffer it is given, without a copy", () => {
    const store = new SavedBaselineStore();
    const saved = chunkOf(8);
    store.set("a", saved);
    expect(store.get("a")).toBe(saved);
    expect(store.get("a")!.asView()).toBe(saved.asView());
  });

  it("is bounded by 512 MB and 512 chunks by default", () => {
    expect(DEFAULT_SAVED_BASELINE_LIMITS).toEqual({
      maxChunks: 512,
      maxBytes: 512 * 1024 * 1024,
    });
  });

  it("evicts the oldest chunks once over the byte bound", () => {
    const store = new SavedBaselineStore({ maxChunks: 100, maxBytes: 300 });
    store.set("a", chunkOf(100));
    store.set("b", chunkOf(100));
    store.set("c", chunkOf(100));
    expect(keysIn(store, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(store.byteLength).toBe(300);

    store.set("d", chunkOf(150));
    expect(keysIn(store, ["a", "b", "c", "d"])).toEqual(["c", "d"]);
    expect(store.byteLength).toBe(250);
  });

  it("still evicts by chunk count", () => {
    const store = new SavedBaselineStore({ maxChunks: 2, maxBytes: 1e9 });
    store.set("a", chunkOf(1));
    store.set("b", chunkOf(1));
    store.set("c", chunkOf(1));
    expect(keysIn(store, ["a", "b", "c"])).toEqual(["b", "c"]);
    expect(store.byteLength).toBe(2);
  });

  it("a re-save replaces the entry and moves it to the back", () => {
    const store = new SavedBaselineStore({ maxChunks: 100, maxBytes: 300 });
    store.set("a", chunkOf(100));
    store.set("b", chunkOf(100));
    const resaved = chunkOf(100);
    store.set("a", resaved);
    expect(store.get("a")).toBe(resaved);
    expect(store.byteLength).toBe(200);

    store.set("c", chunkOf(150));
    // "b" is now the oldest.
    expect(keysIn(store, ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  it("never evicts the newest entry, even alone over the bound", () => {
    const store = new SavedBaselineStore({ maxChunks: 100, maxBytes: 300 });
    store.set("a", chunkOf(100));
    store.set("huge", chunkOf(1000));
    expect(keysIn(store, ["a", "huge"])).toEqual(["huge"]);
    expect(store.byteLength).toBe(1000);
  });

  it("clear drops every entry and its bytes", () => {
    const store = new SavedBaselineStore();
    store.set("a", chunkOf(10));
    store.clear();
    expect(store.get("a")).toBeUndefined();
    expect(store.byteLength).toBe(0);
  });
});
