/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Resolution } from "@zettaai/edit-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalPatchSource } from "#src/editing/local_patch_source.js";
import {
  DERIVED_LEVEL_IDLE_FRAMES,
  LayerPatchOverlay,
  RebuildBudget,
  splitIntoStep,
} from "#src/editing/overlay/layer_patch_overlay.js";
import type { LevelResolutions } from "#src/editing/overlay/level_resolutions.js";
import type { PatchOverlayLevelSource } from "#src/editing/overlay/pyramid_patch_overlay.js";

const FINE = "16x16x40" as Resolution;
const COARSE = "32x32x40" as Resolution;
const CHUNK: [number, number, number] = [4, 4, 1];

/** Column-major 4×4 transform: `scale` in x/y, rotated swaps x and y. */
function transformOf(scale: number, rotated: boolean) {
  const transform = new Float32Array(16);
  transform[rotated ? 1 : 0] = scale;
  transform[rotated ? 4 : 5] = scale;
  transform[10] = 1;
  transform[15] = 1;
  return transform;
}

/**
 * A level `scale` model units per voxel in x/y (scale 1 = 16 nm, 2 = 32 nm)
 * over an 8×8 model area, so its voxel extent is `8 / scale`.
 */
function levelSource(
  scale: number,
  options: { rotated?: boolean; upper?: [number, number, number] } = {},
): PatchOverlayLevelSource {
  return {
    chunkToMultiscaleTransform: transformOf(scale, options.rotated ?? false),
    chunkSource: {
      spec: {
        rank: 3,
        chunkDataSize: CHUNK,
        upperVoxelBound: options.upper ?? [8 / scale, 8 / scale, 1],
      },
    },
  };
}

const levels: LevelResolutions = {
  resolutionOf: (source) =>
    Math.abs(
      source.chunkToMultiscaleTransform[0] +
        source.chunkToMultiscaleTransform[1],
    ) === 1
      ? FINE
      : COARSE,
};

/** Write `value` at voxels `[x, y]` (z = 0) of the store chunk (0,0,0). */
function paint(
  overlay: LayerPatchOverlay,
  resolution: Resolution,
  voxels: [number, number][],
  value: bigint,
) {
  const data = new BigUint64Array(16);
  const patched = new Uint8Array(16);
  for (const [x, y] of voxels) {
    data[x + 4 * y] = value;
    patched[x + 4 * y] = 1;
  }
  overlay.storeFor(resolution).writeFullChunk([0, 0, 0], CHUNK, data, patched);
}

/** The value a level shows at its voxel `[x, y]`, or undefined. */
function shown(
  overlay: LayerPatchOverlay,
  source: PatchOverlayLevelSource,
  [x, y]: [number, number],
) {
  return overlay
    .forChunkSource(source.chunkSource, undefined)
    .getPatchedValueAt(
      [Math.floor(x / 4), Math.floor(y / 4), 0],
      [x % 4, y % 4, 0],
    );
}

function overlayWithLevels() {
  const overlay = new LayerPatchOverlay(levels);
  const fine = levelSource(1);
  const coarse = levelSource(2);
  overlay.observeLevels([fine, coarse]);
  return { overlay, fine, coarse };
}

const BLOCK: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

describe("LayerPatchOverlay", () => {
  it("an empty store of the drawn resolution does not hide another's edits", () => {
    const { overlay, coarse } = overlayWithLevels();
    paint(overlay, FINE, BLOCK, 5n);
    // Created by a read (refetch resync, preview), never written.
    overlay.storeFor(COARSE);
    expect(shown(overlay, coarse, [0, 0])).toBe(5n);
  });

  it("a store with chunks but no edited voxel does not count as edited", () => {
    const { overlay, fine } = overlayWithLevels();
    paint(overlay, FINE, [[2, 1]], 9n);
    // A chunk written without edits (e.g. everything undone to baseline).
    overlay
      .storeFor(COARSE)
      .writeFullChunk(
        [0, 0, 0],
        CHUNK,
        new BigUint64Array(16),
        new Uint8Array(16),
      );
    // Still the single-edited-store fast path: the fine level shows the
    // fine store's own chunk, not a resampled copy.
    const storedChunk = overlay.storeFor(FINE).source.getChunk([0, 0, 0]);
    expect(overlay.shownChunksAt(FINE).map(({ chunk }) => chunk)).toEqual([
      storedChunk,
    ]);
    expect(overlay.shownChunksAt(FINE)[0].chunk).toBe(storedChunk);
    expect(shown(overlay, fine, [2, 1])).toBe(9n);
  });

  it("edits at the drawn resolution but in another chunking are resampled, not shown as is", () => {
    // The session chunks 16 nm in 2×2 chunks; the viewer's 16 nm level uses
    // 4×4. Shown as is, stored chunk (1,0) would be read as viewer chunk
    // (1,0), voxels 4..7, instead of 2..3.
    const { overlay, fine } = overlayWithLevels();
    const data = new BigUint64Array(4);
    const patched = new Uint8Array(4);
    data[0] = 5n;
    patched[0] = 1;
    overlay.storeFor(FINE).writeFullChunk([1, 0, 0], [2, 2, 1], data, patched);
    expect(shown(overlay, fine, [2, 0])).toBe(5n);
    expect(shown(overlay, fine, [4, 0])).toBeUndefined();
  });

  it("edits at two resolutions both show on every level", () => {
    const { overlay, fine, coarse } = overlayWithLevels();
    // A at 16 nm: fine voxels (0..1, 0..1) = coarse voxel (0,0).
    paint(overlay, FINE, BLOCK, 1n);
    // B at 32 nm: coarse voxel (3,3) = fine voxels (6..7, 6..7).
    paint(overlay, COARSE, [[3, 3]], 2n);
    expect(shown(overlay, fine, [0, 0])).toBe(1n);
    expect(shown(overlay, fine, [7, 7])).toBe(2n);
    expect(shown(overlay, coarse, [0, 0])).toBe(1n);
    expect(shown(overlay, coarse, [3, 3])).toBe(2n);
  });

  it("edits at one resolution show as stored on their own level", () => {
    const { overlay, fine } = overlayWithLevels();
    paint(overlay, FINE, [[2, 1]], 9n);
    expect(shown(overlay, fine, [2, 1])).toBe(9n);
    expect(shown(overlay, fine, [1, 2])).toBeUndefined();
  });

  it("a rotated level shows its own resolution's edits as they are", () => {
    const { overlay } = overlayWithLevels();
    const rotated = levelSource(1, { rotated: true });
    overlay.observeLevels([rotated]);
    paint(overlay, FINE, [[2, 1]], 4n);
    expect(shown(overlay, rotated, [2, 1])).toBe(4n);
  });

  it("an emptied store stops contributing", () => {
    const { overlay, fine } = overlayWithLevels();
    paint(overlay, COARSE, [[0, 0]], 3n);
    expect(shown(overlay, fine, [1, 1])).toBe(3n);
    overlay.storeFor(COARSE).clearAll();
    expect(shown(overlay, fine, [1, 1])).toBeUndefined();
  });

  it("a level whose resolution names no stored one still shows the edits as stored", () => {
    // The drawn level's resolution reads differently from the session's
    // (e.g. a rounding difference): nothing can be placed.
    const overlay = new LayerPatchOverlay({
      resolutionOf: () => "16.0001x16x40" as Resolution,
    });
    const fine = levelSource(1);
    overlay.observeLevels([fine]);
    paint(overlay, FINE, [[2, 1]], 4n);
    expect(shown(overlay, fine, [2, 1])).toBe(4n);
  });

  it("levels too far apart in voxel size are not resampled", () => {
    const overlay = new LayerPatchOverlay({
      resolutionOf: (source) =>
        source.chunkToMultiscaleTransform[0] === 1 ? FINE : COARSE,
    });
    const fine = levelSource(1);
    const huge = levelSource(1000, { upper: [1, 1, 1] });
    overlay.observeLevels([fine, huge]);
    paint(overlay, FINE, [[0, 0]], 3n);
    expect(shown(overlay, huge, [0, 0])).toBeUndefined();
  });

  it("undoing every edit leaves no resampled edit behind", () => {
    const { overlay, coarse } = overlayWithLevels();
    paint(overlay, FINE, [[2, 3]], 6n);
    paint(overlay, COARSE, [[3, 3]], 2n);
    expect(overlay.shownChunksAt(FINE).length).toBeGreaterThan(0);
    // Undo to an empty chunk (no box: a history replay), then drop the other.
    overlay
      .storeFor(COARSE)
      .writeFullChunk(
        [0, 0, 0],
        CHUNK,
        new BigUint64Array(16),
        new Uint8Array(16),
      );
    overlay.storeFor(FINE).clearChunk([0, 0, 0]);
    expect(shown(overlay, coarse, [3, 3])).toBeUndefined();
    for (const { chunk } of overlay.shownChunksAt(FINE)) {
      expect(chunk.patched.some((patched) => patched === 1)).toBe(false);
    }
  });

  it("edge chunks of a level whose volume is not a multiple of its chunks share the full chunk layout", () => {
    // The fine level is 6×6 voxels in chunks of 4: chunk (1,*) is clipped to
    // 2 wide by neuroglancer. Draw the edge chunk first, then an inner one.
    const overlay = new LayerPatchOverlay(levels);
    const fine = levelSource(1, { upper: [6, 6, 1] });
    const coarse = levelSource(2, { upper: [3, 3, 1] });
    overlay.observeLevels([fine, coarse]);
    // Coarse voxels (2,0) and (0,0): fine voxels (4..5, 0..1) and (0..1, 0..1).
    paint(
      overlay,
      COARSE,
      [
        [2, 0],
        [0, 0],
      ],
      7n,
    );
    const provider = overlay.forChunkSource(fine.chunkSource, undefined);
    expect(provider.getPatchedValueAt([1, 0, 0], [0, 0, 0])).toBe(7n);
    expect(provider.getPatchedValueAt([0, 0, 0], [1, 1, 0])).toBe(7n);
    for (const { chunk } of overlay.shownChunksAt(FINE)) {
      expect([...chunk.chunkDataSize]).toEqual(CHUNK);
    }
  });

  it("a level with a negative lower bound shows edits at negative voxels", () => {
    // Fine voxel -2 is model -2; the coarse level starts at voxel -1.
    const overlay = new LayerPatchOverlay(levels);
    const fine = levelSource(1);
    const coarse: PatchOverlayLevelSource = {
      chunkToMultiscaleTransform: transformOf(2, false),
      chunkSource: {
        spec: {
          rank: 3,
          chunkDataSize: CHUNK,
          lowerVoxelBound: [-1, -1, 0],
          upperVoxelBound: [4, 4, 1],
        },
      },
    };
    overlay.observeLevels([fine, coarse]);
    // Fine chunk (-1,-1): local (2..3, 2..3) = fine voxels (-2..-1).
    const data = new BigUint64Array(16);
    const patched = new Uint8Array(16);
    for (const [x, y] of [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ]) {
      data[x + 4 * y] = 8n;
      patched[x + 4 * y] = 1;
    }
    overlay.storeFor(FINE).writeFullChunk([-1, -1, 0], CHUNK, data, patched);
    expect(
      overlay
        .forChunkSource(coarse.chunkSource, undefined)
        .getPatchedValueAt([-1, -1, 0], [3, 3, 0]),
    ).toBe(8n);
  });
});

describe("LayerPatchOverlay idle levels", () => {
  let frameNumber = 0;

  /** Draw one viewer frame of `source`. */
  function drawFrame(overlay: LayerPatchOverlay, source: object) {
    overlay.forChunkSource(source, ++frameNumber);
  }

  it("a still picture keeps its resampled level however long it stays", () => {
    const { overlay, fine } = overlayWithLevels();
    paint(overlay, COARSE, [[0, 0]], 3n);
    drawFrame(overlay, fine.chunkSource);
    const first = overlay.forChunkSource(fine.chunkSource, undefined);
    // Neuroglancer draws nothing while nothing changes; hovering reads values
    // but draws no frame.
    for (let read = 0; read < 1000; ++read) {
      overlay.forChunkSource(fine.chunkSource, undefined);
    }
    drawFrame(overlay, fine.chunkSource);
    expect(overlay.forChunkSource(fine.chunkSource, undefined)).toBe(first);
  });

  it("a resampled level not drawn for many drawn frames is freed, its memory with it, and rebuilt on demand", () => {
    const { overlay, fine, coarse } = overlayWithLevels();
    paint(overlay, COARSE, [[0, 0]], 3n);
    drawFrame(overlay, fine.chunkSource);
    const first = overlay.forChunkSource(fine.chunkSource, undefined);
    expect(first.getPatchedValueAt([0, 0, 0], [1, 1, 0])).toBe(3n);
    // Frames that draw only the coarse (stored) level.
    for (let frame = 0; frame <= DERIVED_LEVEL_IDLE_FRAMES + 1; ++frame) {
      drawFrame(overlay, coarse.chunkSource);
    }
    const second = overlay.forChunkSource(fine.chunkSource, undefined);
    expect(second).not.toBe(first);
    // The freed level let go of its chunks even though this test holds it.
    expect(
      (
        first as unknown as {
          store: { source: { chunks: Map<string, unknown> } };
        }
      ).store.source.chunks.size,
    ).toBe(0);
    expect(shown(overlay, fine, [1, 1])).toBe(3n);
  });
});

describe("RebuildBudget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens one window per drawn frame, so a step longer than a frame ends that frame's rebuilding", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const frames = { frame: 1 };
    const budget = new RebuildBudget(frames as never, 6);
    expect(budget.hasTime()).toBe(true);
    // One step took 20 ms, longer than a whole frame.
    vi.advanceTimersByTime(20);
    expect(budget.hasTime()).toBe(false);
    expect(budget.hasTime()).toBe(false);
    frames.frame = 2;
    expect(budget.hasTime()).toBe(true);
  });
});

describe("LayerPatchOverlay levels of one resolution", () => {
  it("two levels of one resolution and chunking but other offsets are resampled apart", () => {
    const overlay = new LayerPatchOverlay(levels);
    const fine = levelSource(1);
    const shifted: PatchOverlayLevelSource = {
      chunkToMultiscaleTransform: (() => {
        const transform = transformOf(2, false);
        transform[12] = 2; // x offset: its voxel 0 covers fine 2..3
        return transform;
      })(),
      chunkSource: {
        spec: { rank: 3, chunkDataSize: CHUNK, upperVoxelBound: [3, 4, 1] },
      },
    };
    const coarse = levelSource(2);
    overlay.observeLevels([fine, coarse, shifted]);
    paint(overlay, FINE, BLOCK, 5n);
    expect(shown(overlay, coarse, [0, 0])).toBe(5n);
    expect(shown(overlay, shifted, [0, 0])).toBeUndefined();
  });
});

describe("LayerPatchOverlay large changes and memory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Fine level of one-voxel chunks under a stored level 32× coarser. */
  function finelyChunked() {
    const overlay = new LayerPatchOverlay({
      resolutionOf: (source) =>
        source.chunkToMultiscaleTransform[0] === 1 ? FINE : COARSE,
    });
    const fine: PatchOverlayLevelSource = {
      chunkToMultiscaleTransform: transformOf(1, false),
      chunkSource: {
        spec: {
          rank: 3,
          chunkDataSize: [1, 1, 1],
          upperVoxelBound: [64, 64, 1],
        },
      },
    };
    const coarse: PatchOverlayLevelSource = {
      chunkToMultiscaleTransform: transformOf(32, false),
      chunkSource: {
        spec: { rank: 3, chunkDataSize: CHUNK, upperVoxelBound: [2, 2, 1] },
      },
    };
    overlay.observeLevels([fine, coarse]);
    return { overlay, fine };
  }

  function derivedChunkCount(provider: unknown) {
    return (provider as { store: { source: { chunks: Map<string, unknown> } } })
      .store.source.chunks.size;
  }

  it("a change over very many target chunks is applied only to chunks drawn or read", () => {
    const { overlay, fine } = finelyChunked();
    // Coarse voxel (0,0) covers fine voxels 0..31 × 0..31: 1024 fine chunks.
    paint(overlay, COARSE, [[0, 0]], 7n);
    const provider = overlay.forChunkSource(fine.chunkSource, undefined);
    expect(derivedChunkCount(provider)).toBe(0);
    expect(provider.getPatchedValueAt([10, 10, 0], [0, 0, 0])).toBe(7n);
    expect(provider.getPatchedValueAt([40, 10, 0], [0, 0, 0])).toBeUndefined();
    expect(derivedChunkCount(provider)).toBe(1);
  });

  it("a chunk that cannot be allocated leaves the level showing nothing, without retrying each frame", () => {
    const { overlay, fine } = overlayWithLevels();
    paint(overlay, COARSE, [[0, 0]], 3n);
    const allocate = vi
      .spyOn(LocalPatchSource.prototype, "getOrCreateChunk")
      .mockImplementation(() => {
        throw new RangeError("Array buffer allocation failed");
      });
    const provider = overlay.forChunkSource(fine.chunkSource, undefined);
    expect(provider.getPatchedValueAt([0, 0, 0], [1, 1, 0])).toBeUndefined();
    const attempts = allocate.mock.calls.length;
    expect(provider.getPatchedValueAt([0, 0, 0], [0, 0, 0])).toBeUndefined();
    expect(allocate.mock.calls.length).toBe(attempts);
  });
});

describe("splitIntoStep", () => {
  const box = { x0: 0, y0: 0, z0: 0, x1: 9, y1: 4, z1: 1 };

  it("takes rows of the first slice up to the voxel limit", () => {
    const { step, rest } = splitIntoStep(box, 20);
    expect(step).toEqual({ x0: 0, y0: 0, z0: 0, x1: 9, y1: 1, z1: 0 });
    expect(rest).toEqual([
      { x0: 0, y0: 0, z0: 1, x1: 9, y1: 4, z1: 1 },
      { x0: 0, y0: 2, z0: 0, x1: 9, y1: 4, z1: 0 },
    ]);
  });

  it("splits a row wider than the limit (a coarse level reading big blocks)", () => {
    const { step, rest } = splitIntoStep(box, 4);
    expect(step).toEqual({ x0: 0, y0: 0, z0: 0, x1: 3, y1: 0, z1: 0 });
    // Everything else is still queued, exactly once.
    const voxels = (part: typeof box) =>
      (part.x1 - part.x0 + 1) *
      (part.y1 - part.y0 + 1) *
      (part.z1 - part.z0 + 1);
    expect(
      voxels(step) + rest.map(voxels).reduce((sum, voxels) => sum + voxels, 0),
    ).toBe(voxels(box));
  });
});
