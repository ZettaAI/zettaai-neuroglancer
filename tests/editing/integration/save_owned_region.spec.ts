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
 * @file The save path's region clipping, through the real `NgSaveTarget`.
 *
 * A boundary chunk is owned by two painting tasks at once, so a save must write
 * only the voxels its own task owns. The unit tests cover the geometry; these
 * cover the SEQUENCING around it, which is where the previous implementation
 * failed review: whether the region is installed and cleared correctly, whether
 * a chunk that cannot be clipped is refused rather than written whole, and
 * whether the box the writer uses is the box the verifier will re-derive.
 *
 * Scope note: driving `EditSessionHost.saveActive` end-to-end would be better
 * still, but `EditSession.open` needs a real `VolumeChunkSource`, a real
 * `UserLayer.dataSources` and `viewer.display.gl` — see the standing note in
 * `edit_session.spec.ts`. That belongs in the Playwright tier against the
 * fake-gcs fixtures. Everything below runs the real `NgSaveTarget`, the real
 * `planOwnedWrite` and a real `SessionRegionSnapshot`; only the backend, the
 * layer manager and the metadata source are fakes.
 */

import type {
  ChunkContentRef,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  SavedChunk,
  SavePayload,
} from "@zettaai/edit-session";
import { Resolution, layerId, sessionId } from "@zettaai/edit-session";
import { afterEach, describe, expect, it } from "vitest";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import { NgSaveTarget } from "#src/editing/adapters/ng_save_target.js";
import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import {
  registerSaveBackend,
  unregisterSaveBackend,
} from "#src/editing/adapters/save_backend.js";
import type { OwnedChunkWrite } from "#src/editing/region/owned_chunk_write.js";
import { planOwnedWrite } from "#src/editing/region/owned_chunk_write.js";
import { SessionRegionSnapshot } from "#src/editing/region/session_region_snapshot.js";
import { FakeLayerManager } from "#tests/editing/fakes/fake_layer_manager.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";

const RESOLUTION = Resolution.from([8, 8, 40]);
const SCHEME = "owned-region-test";
const LAYER = "L1";
/** Deliberately larger than the region below, so chunk 0 straddles it. */
const CHUNK_SIZE: [number, number, number] = [8, 8, 1];

/** Records every chunk the backend is asked to write. */
class RecordingBackend implements SaveBackend {
  readonly received: OwnedChunkWrite[] = [];

  async saveLayer(
    id: LayerId,
    chunks: readonly SavedChunk[],
  ): Promise<SaveBackendResult> {
    this.received.push(...(chunks as readonly OwnedChunkWrite[]));
    return { status: "succeeded", layerId: id, chunkCount: chunks.length };
  }
}

function fakeContentRef(): ChunkContentRef {
  return { hash: "whole-chunk-hash", byteLength: 64 } as ChunkContentRef;
}

/** An 8x8x1 chunk at grid origin, filled with each voxel's linear index. */
function chunk(coord = { x: 0, y: 0, z: 0 }): SavedChunk {
  const bytes = new Uint8Array(
    CHUNK_SIZE[0] * CHUNK_SIZE[1] * CHUNK_SIZE[2],
  ).map((_unused, index) => index);
  return {
    layerId: layerId(LAYER),
    resolution: RESOLUTION,
    chunkId: `${coord.x},${coord.y},${coord.z}`,
    chunkCoord: coord,
    contentRef: fakeContentRef(),
    bytes: {
      byteLength: bytes.byteLength,
      asView: () => bytes,
    } as ReadonlyChunkVoxelBuffer,
  };
}

function payload(chunks: readonly SavedChunk[] = [chunk()]): SavePayload {
  return {
    sessionId: sessionId("test-session"),
    savedAt: 0,
    layerIds: [layerId(LAYER)],
    chunks,
  };
}

const metadata: LayerMetadata = {
  layerId: layerId(LAYER),
  voxelDataType: "uint8",
  channels: 1,
  scales: [
    {
      resolution: RESOLUTION,
      voxelSizeNm: [8, 8, 40],
      voxelOffset: [0, 0, 0],
      sizeVoxels: [64, 64, 64],
      chunkDataSize: CHUNK_SIZE,
    },
  ],
};

function fakeMetadataSource(): NgLayerMetadataSource {
  return {
    async resolve(): Promise<LayerMetadata> {
      return metadata;
    },
  } as unknown as NgLayerMetadataSource;
}

function target(): NgSaveTarget {
  return new NgSaveTarget(
    new FakeLayerManager([
      { name: LAYER, canonicalUrl: `${SCHEME}://x` },
    ]).asLayerManager(),
    fakeMetadataSource(),
    new FakeLogger().asNgLogger(),
  );
}

/** A region covering only x:[0,4) of the 8-wide chunk — a boundary chunk. */
function partialRegion(): SessionRegionSnapshot {
  return new SessionRegionSnapshot(
    sessionId("test-session"),
    new Map([
      [
        `${layerId(LAYER)}|${RESOLUTION}`,
        { loX: 0, loY: 0, loZ: 0, hiX: 4, hiY: 8, hiZ: 1 },
      ],
    ]),
  );
}

function regionCovering(
  hiX: number,
  hiY: number,
  hiZ: number,
  loX = 0,
): SessionRegionSnapshot {
  return new SessionRegionSnapshot(
    sessionId("test-session"),
    new Map([
      [
        `${layerId(LAYER)}|${RESOLUTION}`,
        { loX, loY: 0, loZ: 0, hiX, hiY, hiZ },
      ],
    ]),
  );
}

describe("save region scoping", () => {
  afterEach(() => unregisterSaveBackend(SCHEME));

  it("clears the region after a save completes", async () => {
    const backend = new RecordingBackend();
    registerSaveBackend(SCHEME, backend);
    const saveTarget = target();

    await saveTarget.withSessionRegions(regionCovering(8, 8, 1), () =>
      saveTarget.save(payload()),
    );

    // The region is gone, so a save outside the scope refuses rather than
    // inheriting the previous one.
    const after = await saveTarget.save(payload());
    expect(after.outcomes[0].status).toBe("failed");
  });

  it("clears the region even when the save throws", async () => {
    // The defect this replaces kept a session pinned whenever the cleanup
    // guard did not match, leaving later saves clipping to a dead region.
    // The backend MUST be registered: without one the follow-up save fails for
    // lack of a backend, and the assertion would pass whether or not the
    // region was cleared.
    const backend = new RecordingBackend();
    registerSaveBackend(SCHEME, backend);
    const saveTarget = target();
    await expect(
      saveTarget.withSessionRegions(regionCovering(8, 8, 1), () => {
        throw new Error("save exploded");
      }),
    ).rejects.toThrow("save exploded");

    const after = await saveTarget.save(payload());
    expect(after.outcomes[0].status).toBe("failed");
  });

  it("refuses to nest one save region inside another", async () => {
    const saveTarget = target();
    await saveTarget.withSessionRegions(regionCovering(8, 8, 1), async () => {
      await expect(
        saveTarget.withSessionRegions(regionCovering(4, 4, 1), async () => {}),
      ).rejects.toThrow("already in flight");
    });
  });
});

describe("save refusal (fail closed)", () => {
  afterEach(() => unregisterSaveBackend(SCHEME));

  it("fails the layer, and writes nothing, when no region is installed", async () => {
    const backend = new RecordingBackend();
    registerSaveBackend(SCHEME, backend);

    const result = await target().save(payload());

    // Writing whole chunks here is the overwrite this clipping exists to
    // prevent, so the layer must fail rather than fall back.
    expect(backend.received).toHaveLength(0);
    expect(result.outcomes[0].status).toBe("failed");
  });

  it("fails the layer when a chunk lies wholly outside the region", async () => {
    const backend = new RecordingBackend();
    registerSaveBackend(SCHEME, backend);
    const saveTarget = target();

    // Region sits beyond the chunk entirely.
    const result = await saveTarget.withSessionRegions(
      regionCovering(64, 8, 1, 32),
      () => saveTarget.save(payload()),
    );

    expect(backend.received).toHaveLength(0);
    expect(result.outcomes[0].status).toBe("failed");
  });

  it("fails the whole layer when only SOME chunks are refused", async () => {
    const backend = new RecordingBackend();
    registerSaveBackend(SCHEME, backend);
    const saveTarget = target();

    // Chunk 0 is inside the region; chunk 4 (x 32..40) is not.
    const result = await saveTarget.withSessionRegions(
      regionCovering(8, 8, 1),
      () =>
        saveTarget.save(
          payload([chunk({ x: 0, y: 0, z: 0 }), chunk({ x: 4, y: 0, z: 0 })]),
        ),
    );

    // The library rebaselines a layer reported succeeded, which would make the
    // host's retained copy the only copy — so a partly-written layer must fail
    // and stay dirty.
    expect(result.outcomes[0].status).toBe("failed");
    expect(backend.received).toHaveLength(0);
  });
});

describe("write and verify agree on the owned box", () => {
  afterEach(() => unregisterSaveBackend(SCHEME));

  it("clips a boundary chunk before the backend ever sees it", async () => {
    const backend = new RecordingBackend();
    registerSaveBackend(SCHEME, backend);
    const saveTarget = target();

    await saveTarget.withSessionRegions(partialRegion(), () =>
      saveTarget.save(payload()),
    );

    expect(backend.received).toHaveLength(1);
    const { owned } = backend.received[0];
    expect(owned.coversWholeChunk).toBe(false);
    expect(owned.ownedBox).toEqual({ start: [0, 0, 0], end: [4, 8, 1] });
  });

  it("derives the same owned box the verifier will re-derive", async () => {
    // The invariant the write/verify agreement rests on. The two sides do not
    // share an object: `NgSaveTarget` plans the library's payload, while the
    // host plans its own dirty-chunk snapshot for verification. They agree
    // because both run `planOwnedWrite` over the same frozen snapshot — so
    // that determinism is the thing worth pinning.
    const backend = new RecordingBackend();
    registerSaveBackend(SCHEME, backend);
    const saveTarget = target();
    const regions = partialRegion();
    const subject = chunk();

    await saveTarget.withSessionRegions(regions, () =>
      saveTarget.save(payload([subject])),
    );

    const independent = planOwnedWrite(
      subject,
      metadata,
      metadata.scales[0],
      regions.boundsFor(layerId(LAYER), RESOLUTION),
    );
    expect("write" in independent).toBe(true);
    if (!("write" in independent)) return;
    expect(backend.received[0].owned).toEqual(independent.write.owned);
  });

  it("keeps an interior chunk whole, reusing its existing hash", async () => {
    const backend = new RecordingBackend();
    registerSaveBackend(SCHEME, backend);
    const saveTarget = target();

    await saveTarget.withSessionRegions(regionCovering(8, 8, 1), () =>
      saveTarget.save(payload()),
    );

    const { owned } = backend.received[0];
    // Whole-chunk keeps the request chunk-aligned, which is what lets the
    // backend take its lock-free path instead of a read-modify-write.
    expect(owned.coversWholeChunk).toBe(true);
    // And costs no second hash pass, which matters because interior chunks are
    // the overwhelming majority.
    expect(owned.hash).toBe("whole-chunk-hash");
  });
});
