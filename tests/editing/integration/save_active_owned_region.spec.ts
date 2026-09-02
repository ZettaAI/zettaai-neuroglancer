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
 * @file `EditSessionHost.saveActive` end to end, over the region clip.
 *
 * The property under test is the one the clip's safety rests on and that no
 * narrower test can reach: the host and the library derive the owned box
 * SEPARATELY — the host plans its own dirty-chunk snapshot for verification
 * while `NgSaveTarget` plans the library's payload for the write — and the two
 * must land on the same box for every chunk. If they diverge, the host verifies
 * a box that was never written, or writes one it never verifies, and the save
 * reports a durability it does not have.
 *
 * `EditSession.open` is genuinely out of reach here (it needs a real
 * `VolumeChunkSource`, a real `UserLayer.dataSources` and `viewer.display.gl`).
 * But it is the only thing that is: the session is a small fake exposing the
 * four members `saveActive` touches, the region snapshot is built by the REAL
 * `captureSessionRegions` from that fake, and the save runs through the host's
 * REAL `NgSaveTarget`, the REAL `planOwnedWrite` on both sides, and a recording
 * backend. Only `chunkSource` is stubbed, because read-back needs a live
 * neuroglancer chunk pipeline.
 *
 * `saveTarget` and `chunkSource` are private and constructed in the host's
 * constructor with no injection seam. Reaching them through a cast is
 * deliberate: adding production wiring that exists only for a test would be the
 * worse trade.
 */

import type {
  EditSession,
  LayerId,
  LayerMetadata,
  SavedChunk,
  SavePayload,
  SaveResult,
} from "@zettaai/edit-session";
import { Resolution, layerId, sessionId } from "@zettaai/edit-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import { NgSaveTarget } from "#src/editing/adapters/ng_save_target.js";
import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import {
  registerDefaultSaveBackend,
  clearDefaultSaveBackend,
} from "#src/editing/adapters/save_backend.js";
import { EditSessionHost } from "#src/editing/edit_session_host.js";
import type { OwnedChunkWrite } from "#src/editing/region/owned_chunk_write.js";
import { captureSessionRegions } from "#src/editing/region/session_region_snapshot.js";

import { FakeLayerManager } from "#tests/editing/fakes/fake_layer_manager.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";
import { createFakeViewer } from "#tests/editing/fakes/fake_viewer.js";

vi.hoisted(() => {
  if (typeof (globalThis as any).WebGL2RenderingContext === "undefined") {
    (globalThis as any).WebGL2RenderingContext = {
      UNSIGNED_BYTE: 0x1401,
      BYTE: 0x1400,
      UNSIGNED_SHORT: 0x1403,
      SHORT: 0x1402,
      FLOAT: 0x1406,
      INT: 0x1404,
      UNSIGNED_INT: 0x1405,
    };
  }
});

const RES = Resolution.from([8, 8, 40]);
const LAYER = layerId("L1");
const CHUNK: [number, number, number] = [4, 3, 2];
/** Region owns x:[0,2) of the 4-wide chunk, so chunk 0,0,0 is a boundary chunk. */
const REGION = { loX: 0, loY: 0, loZ: 0, hiX: 2, hiY: 3, hiZ: 2 };

const metadata: LayerMetadata = {
  layerId: LAYER,
  voxelDataType: "uint8",
  channels: 1,
  scales: [
    {
      resolution: RES,
      voxelSizeNm: [8, 8, 40],
      voxelOffset: [0, 0, 0],
      sizeVoxels: [64, 64, 64],
      chunkDataSize: CHUNK,
    },
  ],
};

/** Chunk bytes: each voxel holds its own linear index. */
function chunkBytes(): Uint8Array {
  return new Uint8Array(CHUNK[0] * CHUNK[1] * CHUNK[2]).map(
    (_unused, index) => index,
  );
}

class RecordingBackend implements SaveBackend {
  readonly written: OwnedChunkWrite[] = [];
  async saveLayer(
    id: LayerId,
    chunks: readonly SavedChunk[],
  ): Promise<SaveBackendResult> {
    this.written.push(...(chunks as readonly OwnedChunkWrite[]));
    return { status: "succeeded", layerId: id, chunkCount: chunks.length };
  }
}

/**
 * The four members `saveActive` touches, plus what `captureSessionRegions` and
 * the library's `collectDirtyChunks` read.
 */
function fakeSession(saveTarget: NgSaveTarget, bounds = REGION): EditSession {
  const bytes = chunkBytes();
  const contentRef = {
    hash: "whole-chunk-hash",
    byteLength: bytes.byteLength,
    retain: async () => ({ byteLength: bytes.byteLength, asView: () => bytes }),
  };
  const overlay = {
    differingSlots: () => [
      { layerId: LAYER, resolution: RES, chunkId: "0,0,0" },
    ],
    ensureContentRef: () => contentRef,
  };
  return {
    sessionId: sessionId("fake-session"),
    config: { layers: [{ layerId: LAYER, selectedResolutions: [RES] }] },
    overlay,
    sessionVoxelBoundsFor: () => bounds,
    // `dispose()` discards any active session.
    discard: async () => {},
    // Stands in for the library's `runSave`: builds the payload from the same
    // overlay and hands it to the save target, exactly as `runSave` does.
    save: async (_layerIds?: readonly LayerId[]): Promise<SaveResult> => {
      const payload: SavePayload = {
        sessionId: sessionId("fake-session"),
        savedAt: 0,
        layerIds: [LAYER],
        chunks: [
          {
            layerId: LAYER,
            resolution: RES,
            chunkId: "0,0,0",
            chunkCoord: { x: 0, y: 0, z: 0 },
            contentRef,
            bytes: { byteLength: bytes.byteLength, asView: () => bytes },
          },
        ],
      } as unknown as SavePayload;
      return saveTarget.save(payload);
    },
  } as unknown as EditSession;
}

describe("EditSessionHost.saveActive region clip", () => {
  let host: EditSessionHost;
  let backend: RecordingBackend;

  beforeEach(() => {
    // The save target resolves a backend by the layer's data-source scheme, so
    // the layer has to be resolvable through the viewer's layer manager.
    host = new EditSessionHost(
      createFakeViewer(
        new FakeLayerManager([{ name: "L1", canonicalUrl: "precomputed://x" }]),
      ),
    );
    backend = new RecordingBackend();
    registerDefaultSaveBackend(backend);
    // Read-back needs a live neuroglancer chunk pipeline; stub it so the test
    // is about the derivation, and record what it was asked to confirm.
    (host as any).chunkSource = {
      recordSavedBaseline: () => {},
      getSavedBytes: () => undefined,
      confirmChunkPersisted: vi.fn(async () => true),
    };
    // A REAL NgSaveTarget, but built with fakes: the one the host constructs
    // captures the viewer's metadata source, which would need a live
    // `UserLayer.dataSources` to resolve.
    (host as any).saveTarget = new NgSaveTarget(
      new FakeLayerManager([
        { name: "L1", canonicalUrl: "precomputed://x" },
      ]).asLayerManager(),
      { resolve: async () => metadata } as unknown as NgLayerMetadataSource,
      new FakeLogger().asNgLogger(),
    );
    (host as any).layerMetadataSource = { resolve: async () => metadata };
  });

  afterEach(() => {
    clearDefaultSaveBackend();
    host.dispose();
  });

  /** Wire the fake session in the two places `openSession` would. */
  function activate(bounds = REGION): EditSession {
    const session = fakeSession((host as any).saveTarget, bounds);
    host.activeSession.value = session;
    (host as any).sessionRegions = captureSessionRegions(session);
    return session;
  }

  it("writes the owned sub-box, not the whole chunk", async () => {
    activate();
    const result = await host.saveActive();

    expect(result.overall).toBe("all-succeeded");
    expect(backend.written).toHaveLength(1);
    const { owned } = backend.written[0];
    expect(owned.coversWholeChunk).toBe(false);
    expect(owned.ownedBox).toEqual({ start: [0, 0, 0], end: [2, 3, 2] });
  });

  it("verifies exactly the box it wrote", async () => {
    // The host derives its verification region independently of the one
    // NgSaveTarget derived for the write. They must be the same box and hash,
    // or the save confirms durability for bytes it never sent.
    activate();
    await host.saveActive();

    const confirm = (host as any).chunkSource
      .confirmChunkPersisted as ReturnType<typeof vi.fn>;
    expect(confirm).toHaveBeenCalledTimes(1);
    const verifiedRegion = confirm.mock.calls[0][3];
    expect(verifiedRegion).toEqual(backend.written[0].owned);
  });

  it("fails the save when the session region cannot be captured", async () => {
    // `captureSessionRegions` yielding nothing must not fall back to writing
    // whole chunks — that is the overwrite the clip exists to prevent.
    const session = fakeSession((host as any).saveTarget, REGION);
    (session as any).sessionVoxelBoundsFor = () => undefined;
    host.activeSession.value = session;
    (host as any).sessionRegions = captureSessionRegions(session);

    const result = await host.saveActive();

    expect(backend.written).toHaveLength(0);
    expect(result.overall).not.toBe("all-succeeded");
  });
});

describe("saveCommitted region pinning", () => {
  let host: EditSessionHost;
  let backend: RecordingBackend;

  beforeEach(() => {
    host = new EditSessionHost(
      createFakeViewer(
        new FakeLayerManager([{ name: "L1", canonicalUrl: "precomputed://x" }]),
      ),
    );
    backend = new RecordingBackend();
    registerDefaultSaveBackend(backend);
    (host as any).saveTarget = new NgSaveTarget(
      new FakeLayerManager([
        { name: "L1", canonicalUrl: "precomputed://x" },
      ]).asLayerManager(),
      { resolve: async () => metadata } as unknown as NgLayerMetadataSource,
      new FakeLogger().asNgLogger(),
    );
  });

  afterEach(() => {
    clearDefaultSaveBackend();
    host.activeSession.value = undefined;
    host.dispose();
  });

  /** Commit one chunk for L1 under a session with the given id and region. */
  async function commitUnder(id: string, bounds = REGION): Promise<void> {
    const session = fakeSession((host as any).saveTarget, bounds);
    (session as any).sessionId = sessionId(id);
    (session as any).commit = async () => ({ overall: "all-succeeded" });
    host.activeSession.value = session;
    (host as any).sessionRegions = captureSessionRegions(session);
    // `commitActive` pins from `commitTarget.pendingLayerIds()`, so the layer
    // has to actually be pending.
    // A WELL-FORMED committed chunk: if this were malformed the save would
    // fail for that reason and the refusal under test would pass vacuously.
    const bytes = chunkBytes();
    (host as any).commitTarget = {
      pendingLayerIds: () => [LAYER],
      layerChunks: () => [
        {
          layerId: LAYER,
          resolution: RES,
          chunkId: "0,0,0",
          chunkCoord: { x: 0, y: 0, z: 0 },
          contentRef: {
            hash: "whole-chunk-hash",
            byteLength: bytes.byteLength,
          },
          bytes: { byteLength: bytes.byteLength, asView: () => bytes },
        },
      ],
      clearAll: () => {},
      clearLayer: () => {},
    };
    // Teardown walks the viewer's managed layers, which the fake does not
    // model; the pinning under test happens before it.
    (host as any).commitTeardown = () => {};
    await host.commitActive();
  }

  it("refuses to save committed chunks that span two sessions", async () => {
    // `commitTarget` outlives `openSession`, so a layer committed under two
    // sessions holds chunks from both while one region describes only one of
    // them. Clipping to whichever committed last is silent corruption.
    await commitUnder("session-a", REGION);
    await commitUnder("session-b", { ...REGION, hiX: 4 });

    await expect(host.saveCommitted([LAYER])).resolves.toMatchObject({
      overall: "all-failed",
    });
    expect(backend.written).toHaveLength(0);
  });

  it("keeps the pin when the same session commits twice", async () => {
    await commitUnder("session-a", REGION);
    await commitUnder("session-a", REGION);

    const pinned = (host as any).committedRegions.get(LAYER);
    expect(pinned).toBeDefined();
    expect(typeof pinned).not.toBe("symbol");
  });
});
