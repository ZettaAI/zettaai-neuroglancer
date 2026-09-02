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
  LayerMetadata,
  SavedChunk,
  ScaleMetadata,
  SessionVoxelBounds,
} from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import type {
  OwnedRegion,
  VoxelBoxBounds,
} from "#src/editing/region/owned_chunk_write.js";
import {
  chunkVoxelBox,
  clipToSessionBounds,
  ownedRegionBytes,
  ownedRegionHash,
  planOwnedWrite,
} from "#src/editing/region/owned_chunk_write.js";

const CHUNK: readonly [number, number, number] = [4, 3, 2];

function bounds(
  loX: number,
  loY: number,
  loZ: number,
  hiX: number,
  hiY: number,
  hiZ: number,
): SessionVoxelBounds {
  return { loX, loY, loZ, hiX, hiY, hiZ };
}

/** Chunk buffer filled with each voxel's own linear index. */
function filledChunk(
  size: readonly [number, number, number] = CHUNK,
  channels = 1,
): Uint8Array {
  return new Uint8Array(size[0] * size[1] * size[2] * channels).map(
    (_unused, index) => index,
  );
}

function region(overrides: Partial<OwnedRegion> = {}): OwnedRegion {
  return {
    chunkDataSize: CHUNK,
    bytesPerVoxel: 1,
    channels: 1,
    chunkBox: { start: [0, 0, 0], end: [4, 3, 2] },
    ownedBox: { start: [0, 0, 0], end: [4, 3, 2] },
    coversWholeChunk: true,
    hash: "",
    ...overrides,
  };
}

describe("chunkVoxelBox", () => {
  it("places a chunk on the grid, honouring the voxel offset", () => {
    expect(
      chunkVoxelBox({ x: 2, y: 0, z: 1 }, [64, 64, 8], [10, 20, 30]),
    ).toEqual({ start: [138, 20, 38], end: [202, 84, 46] });
  });
});

describe("clipToSessionBounds", () => {
  const chunkBox: VoxelBoxBounds = {
    start: [0, 0, 0],
    end: [64, 64, 8],
  };

  it("returns the chunk box when the region covers the whole chunk", () => {
    expect(
      clipToSessionBounds(chunkBox, bounds(-10, -10, -10, 100, 100, 100)),
    ).toEqual({ start: [0, 0, 0], end: [64, 64, 8] });
  });

  it("clips a chunk the region only partly covers", () => {
    expect(clipToSessionBounds(chunkBox, bounds(10, 0, 2, 50, 40, 8))).toEqual({
      start: [10, 0, 2],
      end: [50, 40, 8],
    });
  });

  it("returns undefined for a chunk wholly outside the region", () => {
    expect(
      clipToSessionBounds(chunkBox, bounds(64, 0, 0, 128, 64, 8)),
    ).toBeUndefined();
  });
});

describe("ownedRegionBytes", () => {
  it("hands back the buffer uncopied when the region is the whole chunk", () => {
    const chunk = filledChunk();
    const result = ownedRegionBytes(chunk, region());
    // A view over the same memory, not a copy — the interior-chunk fast path.
    expect(result.buffer).toBe(chunk.buffer);
    expect(result.byteOffset).toBe(chunk.byteOffset);
    expect(result.byteLength).toBe(chunk.byteLength);
  });

  it("gathers a sub-box in X-fastest order", () => {
    // x:[1,3) y:[1,3) z:[0,2) over a 4x3x2 chunk.
    const extracted = ownedRegionBytes(
      filledChunk(),
      region({
        ownedBox: { start: [1, 1, 0], end: [3, 3, 2] },
        coversWholeChunk: false,
      }),
    );
    // Plane 0 rows start at 4 and 8; plane 1 (offset 12) at 16 and 20.
    expect(Array.from(extracted)).toEqual([5, 6, 9, 10, 17, 18, 21, 22]);
  });

  it("gathers each channel plane separately (NG is channel-slowest)", () => {
    // Two channels over a 4x3x2 chunk: channel 1 begins at index 24.
    const extracted = ownedRegionBytes(
      filledChunk(CHUNK, 2),
      region({
        channels: 2,
        ownedBox: { start: [0, 0, 0], end: [2, 1, 1] },
        coversWholeChunk: false,
      }),
    );
    // Channel 0 gives voxels 0,1; channel 1 the same voxels one plane on.
    expect(Array.from(extracted)).toEqual([0, 1, 24, 25]);
  });
});

describe("ownedRegionHash", () => {
  it("ignores voxels outside the owned box", () => {
    // The F1 regression, at the unit level: two chunks that differ ONLY in the
    // un-owned half must hash identically, or a shared boundary chunk could
    // never be confirmed once a neighbouring task repainted their side.
    const owned = region({
      ownedBox: { start: [0, 0, 0], end: [2, 3, 2] },
      coversWholeChunk: false,
    });
    const ours = filledChunk();
    const neighbourRepainted = filledChunk();
    for (let index = 0; index < neighbourRepainted.length; index++) {
      const x = index % CHUNK[0];
      if (x >= 2) neighbourRepainted[index] = 200 + x;
    }
    expect(ownedRegionHash(neighbourRepainted, owned)).toBe(
      ownedRegionHash(ours, owned),
    );
  });

  it("still notices a change inside the owned box", () => {
    const owned = region({
      ownedBox: { start: [0, 0, 0], end: [2, 3, 2] },
      coversWholeChunk: false,
    });
    const clobbered = filledChunk();
    clobbered[0] = 250;
    expect(ownedRegionHash(clobbered, owned)).not.toBe(
      ownedRegionHash(filledChunk(), owned),
    );
  });
});

const metadata = {
  voxelDataType: "uint8",
  channels: 1,
} as unknown as LayerMetadata;

const scale = {
  chunkDataSize: CHUNK,
  voxelOffset: [0, 0, 0],
} as unknown as ScaleMetadata;

function chunkAt(coord: { x: number; y: number; z: number }): SavedChunk {
  const bytes = filledChunk();
  return {
    layerId: "layer-1",
    resolution: "8x8x40",
    chunkId: `${coord.x},${coord.y},${coord.z}`,
    chunkCoord: coord,
    contentRef: { hash: "whole-chunk-hash" },
    bytes: { asView: () => bytes },
  } as unknown as SavedChunk;
}

describe("planOwnedWrite", () => {
  it("refuses a chunk whose scale has no region", () => {
    const plan = planOwnedWrite(
      chunkAt({ x: 0, y: 0, z: 0 }),
      metadata,
      scale,
      undefined,
    );
    expect(plan).toEqual({ refusal: { kind: "no-edit-region-for-scale" } });
  });

  it("refuses a chunk that lies wholly outside the region", () => {
    const plan = planOwnedWrite(
      chunkAt({ x: 0, y: 0, z: 0 }),
      metadata,
      scale,
      bounds(100, 0, 0, 200, 3, 2),
    );
    expect(plan).toEqual({ refusal: { kind: "chunk-outside-edit-region" } });
  });

  it("reuses the chunk's existing hash when the region covers it whole", () => {
    const plan = planOwnedWrite(
      chunkAt({ x: 0, y: 0, z: 0 }),
      metadata,
      scale,
      bounds(0, 0, 0, 4, 3, 2),
    );
    expect("write" in plan && plan.write.owned.coversWholeChunk).toBe(true);
    // No second FNV pass for interior chunks — the common case.
    expect("write" in plan && plan.write.owned.hash).toBe("whole-chunk-hash");
  });

  it("clips a boundary chunk and hashes only the owned voxels", () => {
    const plan = planOwnedWrite(
      chunkAt({ x: 0, y: 0, z: 0 }),
      metadata,
      scale,
      bounds(0, 0, 0, 2, 3, 2),
    );
    expect("write" in plan).toBe(true);
    if (!("write" in plan)) return;
    const { owned } = plan.write;
    expect(owned.coversWholeChunk).toBe(false);
    expect(owned.ownedBox).toEqual({ start: [0, 0, 0], end: [2, 3, 2] });
    expect(owned.hash).toBe(ownedRegionHash(filledChunk(), owned));
    expect(owned.hash).not.toBe("whole-chunk-hash");
  });
});
