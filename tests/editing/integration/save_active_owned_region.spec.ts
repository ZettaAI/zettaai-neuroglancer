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
import { SaveConflictError } from "#src/editing/reconcile/save_conflict_refusal.js";
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

/**
 * What a fresh read of the remote returns, in the shape `readFreshDecoded`
 * resolves to. `mutate` stands in for another annotator having written.
 */
function remoteBytes(mutate?: (bytes: Uint8Array) => void) {
  const bytes = chunkBytes();
  mutate?.(bytes);
  return { byteLength: bytes.byteLength, asView: () => bytes };
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
    // The stale-baseline scan falls back to the session's opening baseline
    // when no chunk has been saved yet this session.
    baselineRefOf: () => contentRef,
  };
  // `saveActive` fingerprints the dirty set across its planning window and
  // refuses if it moved; `bump()` lets a test simulate paint landing there.
  let layerVersion = 1;
  const dirty = {
    getLayerVersion: () => layerVersion,
    getDirtyChunks: () => new Set(["L1|8x8x40|0,0,0"]),
    bump: () => {
      layerVersion += 1;
    },
  };
  return {
    sessionId: sessionId("fake-session"),
    config: { layers: [{ layerId: LAYER, selectedResolutions: [RES] }] },
    overlay,
    dirty,
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
      // The stale-baseline scan fresh-reads every chunk before the write. The
      // default answers with the bytes the save is about to send, i.e. nobody
      // moved the region; tests about conflicts override this.
      readFreshDecoded: vi.fn(async () => remoteBytes()),
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

  it("refuses when the overlay changes while the save is being planned", async () => {
    // The write/verify agreement rests on nothing mutating the overlay between
    // the host's collect and the library's. Simulate a paint landing there.
    const session = activate();
    const inner = (host as any).layerMetadataSource.resolve;
    (host as any).layerMetadataSource = {
      resolve: async (id: LayerId) => {
        (session as any).dirty.bump();
        return inner(id);
      },
    };

    await expect(host.saveActive()).rejects.toThrow(
      "edit overlay changed while the save was being prepared",
    );
    expect(backend.written).toHaveLength(0);
  });

  /**
   * The stale-baseline gate, over the same clip. The owned box is x in [0,2),
   * so x=1 is ours and x=3 belongs to the neighbouring task that shares this
   * boundary chunk — the distinction the whole scan rests on.
   */
  describe("stale-baseline gate", () => {
    function remoteWrites(voxel: number): void {
      (host as any).chunkSource.readFreshDecoded = vi.fn(async () =>
        remoteBytes((bytes) => {
          bytes[voxel] = 200;
        }),
      );
    }

    it("refuses, and writes nothing, when the remote moved inside our box", async () => {
      activate();
      remoteWrites(1); // x=1 — ours

      await expect(host.saveActive()).rejects.toThrow(SaveConflictError);
      expect(backend.written).toHaveLength(0);
    });

    it("saves normally when a neighbour wrote outside our box", async () => {
      activate();
      remoteWrites(3); // x=3 — the neighbour's half of the same chunk

      const result = await host.saveActive();
      expect(result.overall).toBe("all-succeeded");
      expect(backend.written).toHaveLength(1);
    });

    it("writes anyway once the user has chosen to overwrite", async () => {
      activate();
      remoteWrites(1);

      const result = await host.saveActive(undefined, undefined, "overwrite");
      expect(result.overall).toBe("all-succeeded");
      expect(backend.written).toHaveLength(1);
    });

    it("skips the scan entirely when overwriting", async () => {
      activate();
      remoteWrites(1);

      await host.saveActive(undefined, undefined, "overwrite");
      expect(
        (host as any).chunkSource.readFreshDecoded as ReturnType<typeof vi.fn>,
      ).not.toHaveBeenCalled();
    });

    it("refuses when no retained baseline can prove the region untouched", async () => {
      // Neither a saved copy nor an opening baseline: unprovable, not clean.
      const session = activate();
      (session as any).overlay.baselineRefOf = () => undefined;
      remoteWrites(1);

      await expect(host.saveActive()).rejects.toThrow(SaveConflictError);
      expect(backend.written).toHaveLength(0);
    });

    /**
     * The scan is real network I/O, and it sits inside the window
     * `owned_chunk_write.ts` requires to stay microtask-only: the host has
     * already snapshotted the chunks it will verify, and the library has not
     * yet collected the ones it will write. Paint landing in between makes
     * those two sets differ — the library writes chunks this save never
     * scanned for conflicts and never verifies.
     */
    it("refuses when paint lands while the conflict scan is running", async () => {
      const session = activate();
      (host as any).chunkSource.readFreshDecoded = vi.fn(async () => {
        (session as any).dirty.bump(); // a paint tile commits mid-scan
        return remoteBytes();
      });

      await expect(host.saveActive()).rejects.toThrow(
        "changed while the save was being prepared or checked",
      );
      expect(backend.written).toHaveLength(0);
    });

    /**
     * `saveActive` records a chunk's saved bytes as soon as the write is acked,
     * BEFORE read-back proves the backend holds them. If that verification
     * never confirms, those bytes are only an attempt — and the merge kernel
     * reads the baseline as ground truth for "did I change this voxel", so
     * trusting them would hand every voxel of that attempt to the remote and
     * silently revert the user's own paint.
     */
    it("treats an unconfirmed save's bytes as unprovable, not as a baseline", async () => {
      activate();
      const attempted = chunkBytes();
      (host as any).chunkSource.getSavedBytes = () => ({
        byteLength: attempted.byteLength,
        asView: () => attempted,
      });
      (host as any).unconfirmedChunks.set("L1|8x8x40|0,0,0", {});
      // Remote reads back pristine — the acked write never actually landed.
      (host as any).chunkSource.readFreshDecoded = vi.fn(async () =>
        remoteBytes((bytes) => bytes.fill(0)),
      );

      const error = await host.saveActive().catch((thrown) => thrown);

      expect(error).toBeInstanceOf(SaveConflictError);
      // Unprovable, NOT diverged: a diverged chunk would offer Merge, and the
      // merge is exactly what would eat the paint.
      expect(error.scan.uncomparable).toHaveLength(1);
      expect(error.scan.uncomparable[0].reason).toBe("no-retained-baseline");
      expect(error.scan.diverged).toHaveLength(0);
      expect(backend.written).toHaveLength(0);
    });

    it("carries what diverged on the error, for the dialog to list", async () => {
      activate();
      remoteWrites(1);

      const error = await host.saveActive().catch((thrown) => thrown);
      expect(error).toBeInstanceOf(SaveConflictError);
      expect(error.scan.diverged).toHaveLength(1);
      expect(error.scan.diverged[0].write.chunkId).toBe("0,0,0");
      expect(error.scan.uncomparable).toHaveLength(0);
    });
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
  async function commitUnder(
    id: string,
    bounds = REGION,
    configLayers: readonly LayerId[] = [LAYER],
    pendingLayers: readonly LayerId[] = [LAYER],
  ): Promise<void> {
    const session = fakeSession((host as any).saveTarget, bounds);
    (session as any).sessionId = sessionId(id);
    (session as any).config = {
      layers: configLayers.map((id) => ({
        layerId: id,
        selectedResolutions: [RES],
      })),
    };
    (session as any).commit = async () => ({ overall: "all-succeeded" });
    host.activeSession.value = session;
    (host as any).sessionRegions = captureSessionRegions(session);
    // `commitActive` pins from `commitTarget.pendingLayerIds()`, so the layer
    // has to actually be pending.
    // A WELL-FORMED committed chunk: if this were malformed the save would
    // fail for that reason and the refusal under test would pass vacuously.
    const bytes = chunkBytes();
    (host as any).commitTarget = {
      pendingLayerIds: () => pendingLayers,
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

  it("leaves an earlier session's pin alone when a later session commits another layer", async () => {
    // `pendingLayerIds()` returns every layer in the store, not just the ones
    // this commit touched. Marking an untouched layer ambiguous would strand
    // work whose region is known exactly, and the only escape would be
    // `resetLayer`, which discards it.
    const other = layerId("L3");
    await commitUnder("session-a", REGION, [LAYER], [LAYER]);
    const pinnedAfterA = (host as any).committedRegions.get(LAYER);

    // Session B selects only L3; the store still reports L1 alongside it.
    await commitUnder(
      "session-b",
      { ...REGION, hiX: 4 },
      [other],
      [LAYER, other],
    );

    expect((host as any).committedRegions.get(LAYER)).toBe(pinnedAfterA);
  });
});
