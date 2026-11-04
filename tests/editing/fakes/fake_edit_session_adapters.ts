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
 * A real library `EditSession` over one uint8 layer with a zero baseline and
 * do-nothing adapters, for specs that exercise host hooks on the session
 * (TM-373). Not a Neuroglancer layer: no chunk pipeline, no viewer.
 */

import {
  ChunkId,
  EditSession,
  Resolution,
  layerId,
  type EditSessionAdapters,
  type LayerMetadata,
  type OverlayCoord,
  type ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";

export const FAKE_LAYER = layerId("A");
export const FAKE_RESOLUTION = Resolution.from([4, 4, 40]);
export const FAKE_CHUNK_SIZE = [16, 16, 16] as const;

/** Chunk `x` along the volume's first axis (the volume is 2 × 1 × 1 chunks). */
export function fakeChunkCoord(x = 0): OverlayCoord {
  return {
    layerId: FAKE_LAYER,
    resolution: FAKE_RESOLUTION,
    chunkId: ChunkId.fromCoord({ x, y: 0, z: 0 }),
  };
}

function layerMetadata(): LayerMetadata {
  return {
    layerId: FAKE_LAYER,
    voxelDataType: "uint8",
    channels: 1,
    scales: [
      {
        resolution: FAKE_RESOLUTION,
        voxelSizeNm: [4, 4, 40],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [32, 16, 16],
        chunkDataSize: FAKE_CHUNK_SIZE,
      },
    ],
  };
}

function fakeAdapters(): EditSessionAdapters {
  const metadata = layerMetadata();
  const silent = () => {};
  const [sizeX, sizeY, sizeZ] = FAKE_CHUNK_SIZE;
  return {
    layerMetadata: { resolve: async () => metadata },
    chunks: {
      pinChunks: async () => {},
      releasePins: () => {},
      readBaselineChunk: async (): Promise<ReadonlyChunkVoxelBuffer> => {
        const view = new Uint8Array(sizeX * sizeY * sizeZ);
        return { byteLength: view.byteLength, asView: () => view };
      },
    },
    commit: { accept: async () => ({ ok: true }) as never },
    save: { save: async () => ({ ok: true }) as never },
    lock: {
      acquire: async (id) => ({
        sessionId: id,
        acquiredAt: 0,
        release: () => {},
      }),
    },
    clock: { now: () => 0, wallTime: () => 0 },
    logger: {
      level: "silent",
      error: silent,
      warn: silent,
      info: silent,
      debug: silent,
    },
  };
}

/** Open a session over the whole fake volume. */
export function openFakeEditSession(): Promise<EditSession> {
  return EditSession.open(
    {
      layers: [{ layerId: FAKE_LAYER, selectedResolutions: [FAKE_RESOLUTION] }],
      region: { bbox: [0, 0, 0, 32, 16, 16], resolution: FAKE_RESOLUTION },
    },
    fakeAdapters(),
  );
}
