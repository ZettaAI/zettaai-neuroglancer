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
 * @file `EditDraftStore` against a real IndexedDB.
 *
 * Browser tier on purpose: node and jsdom have no IndexedDB, and a fake would
 * test the shim rather than the thing the recovery path depends on. What
 * matters here is that voxel bytes survive the round trip byte-for-byte —
 * a draft that comes back subtly altered is worse than one that fails loudly.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { EditDraft } from "#src/editing/draft/edit_draft.js";
import { EditDraftStore } from "#src/editing/draft/edit_draft_store.js";

function draft(draftId: string, overrides: Partial<EditDraft> = {}): EditDraft {
  return {
    draftId,
    savedAt: 1000,
    reason: "before-overwrite",
    scopes: ["L1|8x8x40"],
    chunks: [
      {
        layerId: "L1",
        resolution: "8x8x40",
        voxelSizeNm: [8, 8, 40] as const,
        chunkId: "0,0,0",
        bytes: Uint8Array.from([1, 2, 3, 250, 0, 255]),
      },
    ],
    ...overrides,
  };
}

const opened: EditDraftStore[] = [];

async function store(): Promise<EditDraftStore> {
  const instance = await EditDraftStore.open();
  opened.push(instance);
  return instance;
}

afterEach(async () => {
  const instance = opened.pop();
  if (instance === undefined) return;
  for (const summary of await instance.list()) {
    await instance.delete(summary.draftId);
  }
  instance.close();
  while (opened.length > 0) opened.pop()?.close();
});

describe("EditDraftStore", () => {
  it("round-trips voxel bytes unchanged", async () => {
    const drafts = await store();
    await drafts.put(draft("round-trip"));

    const restored = await drafts.get("round-trip");

    expect(restored).toBeDefined();
    expect(Array.from(restored!.chunks[0].bytes)).toEqual([
      1, 2, 3, 250, 0, 255,
    ]);
    expect(restored!.chunks[0].chunkId).toBe("0,0,0");
    expect(restored!.reason).toBe("before-overwrite");
  });

  it("returns undefined for a draft that was never written", async () => {
    const drafts = await store();
    expect(await drafts.get("absent")).toBeUndefined();
  });

  it("keeps one draft per region rather than a history", async () => {
    const drafts = await store();
    await drafts.put(draft("same-region", { savedAt: 1 }));
    await drafts.put(draft("same-region", { savedAt: 2 }));

    expect(await drafts.list()).toHaveLength(1);
    expect((await drafts.get("same-region"))?.savedAt).toBe(2);
  });

  it("lists newest first, without loading bytes", async () => {
    const drafts = await store();
    await drafts.put(draft("older", { savedAt: 10 }));
    await drafts.put(draft("newer", { savedAt: 20 }));

    const listed = await drafts.list();

    expect(listed.map((entry) => entry.draftId)).toEqual(["newer", "older"]);
    expect(listed[0].chunkCount).toBe(1);
    expect("chunks" in listed[0]).toBe(false);
  });

  it("forgets a draft once it is deleted", async () => {
    const drafts = await store();
    await drafts.put(draft("temporary"));

    await drafts.delete("temporary");

    expect(await drafts.get("temporary")).toBeUndefined();
  });

  it("survives being reopened, which is the whole point", async () => {
    const first = await store();
    await first.put(draft("across-tabs"));
    first.close();
    opened.pop();

    const second = await store();
    expect(await second.get("across-tabs")).toBeDefined();
  });
});
