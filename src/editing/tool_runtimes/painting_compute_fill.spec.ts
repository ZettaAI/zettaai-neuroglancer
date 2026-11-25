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
 * `PaintingCompute.fill` against a target whose scale has a `voxelOffset`.
 *
 * The library's chunk grid is anchored at the scale's `voxelOffset`: chunk
 * `(x, y, z)` starts at `voxelOffset + coord * chunkDataSize`. The fake target
 * below serves chunks on exactly that grid, so a flood that looks a voxel up on
 * a grid anchored at 0 reads data from the wrong place and fills the wrong
 * shape (seen on the ant segmentation, offset 1024).
 */

import type {
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
} from "@zettaai/edit-session";
import {
  ChunkId,
  Resolution as ResolutionCtor,
  layerId,
} from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import type {
  FillMode,
  PaintWriteBatch,
} from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";

type Triple = readonly [number, number, number];

const RESOLUTION: Resolution = ResolutionCtor.from([16, 16, 42]);
const TARGET: LayerId = layerId("target");
const CHUNK_SIZE: Triple = [16, 16, 4];
/** The volume the fill may touch, in voxels from the scale's offset. */
const VOLUME_SIZE: Triple = [48, 48, 8];

const EMPTY = 0;
const CELL = 5;
const NEIGHBOUR = 9;
const FILL_VALUE = 7;

/**
 * A segmentation in coordinates relative to the scale's offset: background
 * empty, a CELL box spanning chunk boundaries on z 2..5, a NEIGHBOUR box
 * touching it, and an empty hole inside the CELL on z 3 only.
 */
function segmentAt(x: number, y: number, z: number): number {
  const insideCell = x >= 6 && x <= 30 && y >= 6 && y <= 30 && z >= 2 && z <= 5;
  const insideHole = x >= 12 && x <= 20 && y >= 12 && y <= 20 && z === 3;
  const insideNeighbour =
    x >= 31 && x <= 40 && y >= 6 && y <= 30 && z >= 2 && z <= 5;
  if (insideHole) return EMPTY;
  if (insideCell) return CELL;
  if (insideNeighbour) return NEIGHBOUR;
  return EMPTY;
}

function metadataWithOffset(voxelOffset: Triple): LayerMetadata {
  return {
    layerId: TARGET,
    voxelDataType: "uint32",
    channels: 1,
    scales: [
      {
        resolution: RESOLUTION,
        voxelSizeNm: [16, 16, 42],
        voxelOffset: [...voxelOffset],
        sizeVoxels: [...VOLUME_SIZE],
        chunkDataSize: [...CHUNK_SIZE],
      },
    ],
  };
}

/**
 * Serves chunks on the library's grid: chunk coordinates count from the
 * scale's offset, so chunk (0, 0, 0) holds the volume's first voxels.
 */
function offsetAnchoredReader(): (
  chunkId: ChunkId,
) => Promise<ReadonlyChunkVoxelBuffer> {
  const [chunkSizeX, chunkSizeY, chunkSizeZ] = CHUNK_SIZE;
  return async (chunkId) => {
    const coord = ChunkId.toCoord(chunkId);
    const data = new Uint32Array(chunkSizeX * chunkSizeY * chunkSizeZ);
    for (let z = 0; z < chunkSizeZ; z++) {
      for (let y = 0; y < chunkSizeY; y++) {
        for (let x = 0; x < chunkSizeX; x++) {
          const relativeX = coord.x * chunkSizeX + x;
          const relativeY = coord.y * chunkSizeY + y;
          const relativeZ = coord.z * chunkSizeZ + z;
          const insideVolume =
            relativeX >= 0 &&
            relativeY >= 0 &&
            relativeZ >= 0 &&
            relativeX < VOLUME_SIZE[0] &&
            relativeY < VOLUME_SIZE[1] &&
            relativeZ < VOLUME_SIZE[2];
          data[x + chunkSizeX * (y + chunkSizeY * z)] = insideVolume
            ? segmentAt(relativeX, relativeY, relativeZ)
            : EMPTY;
        }
      }
    }
    return { byteLength: data.byteLength, asView: () => data };
  };
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * Absolute voxels a batch paints, located the way `applyPaintBatch` does:
 * `chunkCoord * chunkDataSize + subregion origin`.
 */
function paintedVoxels(batch: PaintWriteBatch): Set<string> {
  const painted = new Set<string>();
  const [chunkSizeX, chunkSizeY, chunkSizeZ] = CHUNK_SIZE;
  for (const write of batch.chunks) {
    const [originX, originY, originZ] = write.subregion.origin;
    const [width, height] = write.subregion.size;
    const baseX = write.chunkCoord.x * chunkSizeX + originX;
    const baseY = write.chunkCoord.y * chunkSizeY + originY;
    const baseZ = write.chunkCoord.z * chunkSizeZ + originZ;
    for (let i = 0; i < write.values.length; i++) {
      if (write.valueMask !== undefined && write.valueMask[i] === 0) continue;
      expect(Number(write.values[i])).toBe(FILL_VALUE);
      painted.add(
        key(
          baseX + (i % width),
          baseY + (Math.floor(i / width) % height),
          baseZ + Math.floor(i / (width * height)),
        ),
      );
    }
  }
  return painted;
}

/** Plain flood over `segmentAt`, in absolute voxels. */
function expectedVoxels(
  voxelOffset: Triple,
  seed: Triple,
  mode: FillMode,
): Set<string> {
  const [offsetX, offsetY, offsetZ] = voxelOffset;
  const valueAt = (x: number, y: number, z: number) =>
    segmentAt(x - offsetX, y - offsetY, z - offsetZ);
  const insideVolume = (x: number, y: number, z: number) =>
    x >= offsetX &&
    y >= offsetY &&
    z >= offsetZ &&
    x < offsetX + VOLUME_SIZE[0] &&
    y < offsetY + VOLUME_SIZE[1] &&
    z < offsetZ + VOLUME_SIZE[2];
  const seedValue = valueAt(...seed);
  const reached = new Set<string>();
  const pending: Triple[] = [seed];
  while (pending.length > 0) {
    const [x, y, z] = pending.pop()!;
    if (!insideVolume(x, y, z) || reached.has(key(x, y, z))) continue;
    if (valueAt(x, y, z) !== seedValue) continue;
    reached.add(key(x, y, z));
    pending.push([x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z]);
    if (mode === "3d") pending.push([x, y, z + 1], [x, y, z - 1]);
  }
  return reached;
}

async function fillFrom(
  voxelOffset: Triple,
  relativeSeed: Triple,
  mode: FillMode,
): Promise<{ painted: Set<string>; expected: Set<string> }> {
  const [offsetX, offsetY, offsetZ] = voxelOffset;
  const seed: Triple = [
    offsetX + relativeSeed[0],
    offsetY + relativeSeed[1],
    offsetZ + relativeSeed[2],
  ];
  const batch = await new PaintingCompute().fill({
    targetLayerId: TARGET,
    targetResolution: RESOLUTION,
    metadata: metadataWithOffset(voxelOffset),
    seedVoxelPosition: seed,
    value: FILL_VALUE,
    mode,
    bounds: {
      loX: offsetX,
      loY: offsetY,
      loZ: offsetZ,
      hiX: offsetX + VOLUME_SIZE[0],
      hiY: offsetY + VOLUME_SIZE[1],
      hiZ: offsetZ + VOLUME_SIZE[2],
    },
    readChunk: offsetAnchoredReader(),
  });
  return {
    painted: paintedVoxels(batch),
    expected: expectedVoxels(voxelOffset, seed, mode),
  };
}

const OFFSETS: readonly { name: string; voxelOffset: Triple }[] = [
  { name: "no offset", voxelOffset: [0, 0, 0] },
  // The ant segmentation: 1024 at 16 nm, a whole number of chunks.
  { name: "offset of whole chunks", voxelOffset: [32, 48, 4] },
  // The portal data: an offset that is not a multiple of the chunk size.
  { name: "offset off the chunk grid", voxelOffset: [5, 11, 3] },
];

const CASES: readonly {
  name: string;
  relativeSeed: Triple;
  mode: FillMode;
}[] = [
  { name: "2D on a segment", relativeSeed: [8, 8, 3], mode: "2d" },
  { name: "3D on a segment", relativeSeed: [8, 8, 3], mode: "3d" },
  { name: "2D on enclosed empty space", relativeSeed: [16, 16, 3], mode: "2d" },
  { name: "3D on enclosed empty space", relativeSeed: [16, 16, 3], mode: "3d" },
  { name: "2D on open empty space", relativeSeed: [2, 2, 3], mode: "2d" },
  { name: "3D on open empty space", relativeSeed: [2, 2, 3], mode: "3d" },
];

describe("PaintingCompute.fill reads the target on the library's chunk grid", () => {
  for (const { name: offsetName, voxelOffset } of OFFSETS) {
    for (const { name, relativeSeed, mode } of CASES) {
      it(`${name}, ${offsetName}`, async () => {
        const { painted, expected } = await fillFrom(
          voxelOffset,
          relativeSeed,
          mode,
        );
        expect(expected.size).toBeGreaterThan(0);
        expect([...painted].sort()).toEqual([...expected].sort());
      });
    }
  }
});
