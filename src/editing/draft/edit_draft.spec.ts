/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import type { EditDraft } from "#src/editing/draft/edit_draft.js";
import {
  draftByteLength,
  draftIdForRegion,
  summarizeDraft,
} from "#src/editing/draft/edit_draft.js";

const SCOPES = [
  { layerId: "L1", resolution: "8x8x40" },
  { layerId: "L2", resolution: "8x8x40" },
];
const START: [number, number, number] = [0, 0, 0];
const END: [number, number, number] = [64, 64, 8];

function draft(overrides: Partial<EditDraft> = {}): EditDraft {
  return {
    draftId: "d1",
    savedAt: 1000,
    reason: "before-overwrite",
    scopes: ["L1|8x8x40"],
    chunks: [
      {
        layerId: "L1",
        resolution: "8x8x40",
        voxelSizeNm: [8, 8, 40] as const,
        chunkId: "0,0,0",
        bytes: new Uint8Array(16),
      },
      {
        layerId: "L1",
        resolution: "8x8x40",
        voxelSizeNm: [8, 8, 40] as const,
        chunkId: "1,0,0",
        bytes: new Uint8Array(8),
      },
    ],
    ...overrides,
  };
}

describe("draftIdForRegion", () => {
  it("is stable across runs for the same work", () => {
    expect(draftIdForRegion(SCOPES, START, END)).toBe(
      draftIdForRegion(SCOPES, START, END),
    );
  });

  /**
   * The session that recovers a draft is not the one that wrote it, and it
   * has no reason to list its layers in the same order.
   */
  it("does not depend on the order layers are listed in", () => {
    expect(draftIdForRegion([...SCOPES].reverse(), START, END)).toBe(
      draftIdForRegion(SCOPES, START, END),
    );
  });

  it("separates different regions", () => {
    expect(draftIdForRegion(SCOPES, START, [64, 64, 16])).not.toBe(
      draftIdForRegion(SCOPES, START, END),
    );
  });

  it("separates different layers over the same region", () => {
    expect(
      draftIdForRegion([{ layerId: "L9", resolution: "8x8x40" }], START, END),
    ).not.toBe(draftIdForRegion(SCOPES, START, END));
  });

  it("separates the same layer at a different resolution", () => {
    expect(
      draftIdForRegion([{ layerId: "L1", resolution: "16x16x40" }], START, END),
    ).not.toBe(
      draftIdForRegion([{ layerId: "L1", resolution: "8x8x40" }], START, END),
    );
  });
});

describe("summarizeDraft", () => {
  it("keeps the metadata a chooser needs and drops the bytes", () => {
    const summary = summarizeDraft(draft());
    expect(summary.chunkCount).toBe(2);
    expect(summary.reason).toBe("before-overwrite");
    expect(summary.savedAt).toBe(1000);
    expect("chunks" in summary).toBe(false);
  });
});

describe("draftByteLength", () => {
  it("totals every chunk's bytes", () => {
    expect(draftByteLength(draft())).toBe(24);
  });

  it("is zero for a draft with no chunks", () => {
    expect(draftByteLength(draft({ chunks: [] }))).toBe(0);
  });
});
