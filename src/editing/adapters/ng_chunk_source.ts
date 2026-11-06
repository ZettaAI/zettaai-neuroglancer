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
  ChunkCoord,
  ChunkId,
  ChunkSource as LibraryChunkSource,
  ChunkVoxelBuffer,
  LayerId,
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  SessionId,
} from "@zettaai/edit-session";
import {
  ChunkReadAbortedError,
  ChunkReadFailedError,
} from "@zettaai/edit-session";

import type { ChunkManager, Chunk } from "#src/chunk_manager/frontend.js";
import {
  decodeCompressedBaseline,
  padToEditSize,
  type CompressedBaselineChunk,
} from "#src/editing/adapters/baseline_chunk_decode.js";
import { decodeBaselineOffMainThread } from "#src/editing/adapters/baseline_decode_pool.js";
import {
  boxSize,
  boxVoxelCount,
  readCompressedSegmentationBox,
} from "#src/editing/adapters/compressed_segmentation_box_read.js";
import { editChunkDataSize } from "#src/editing/adapters/edit_chunk_extent.js";
import { makeChunkGridPosition } from "#src/editing/adapters/ng_chunk_grid.js";
import { resolutionFor } from "#src/editing/adapters/ng_layer_metadata_source.js";
import { SavedBaselineStore } from "#src/editing/adapters/saved_baseline_store.js";
import type { ChunkLoadProgressState } from "#src/editing/adapters/session_chunk_preloader.js";
import {
  pinBudgetFor,
  preloadPoolSizeFor,
  SessionChunkPreloader,
} from "#src/editing/adapters/session_chunk_preloader.js";
import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import type { OwnedRegion } from "#src/editing/region/owned_chunk_write.js";
import { ownedRegionHash } from "#src/editing/region/owned_chunk_write.js";
import type { LayerManager, UserLayer } from "#src/layer/index.js";
import type { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type {
  VolumeChunkSpecification,
  VolumeSourceOptions,
} from "#src/sliceview/volume/base.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";

/**
 * Adapter that exposes neuroglancer's per-layer volumetric chunk storage
 * through the edit-session library's flat `(layerId, resolution, chunkId)`
 * coordinate space. Pin / release operations are tracked per active session
 * (the library guarantees one session active at a time); baseline reads route
 * through `SliceViewChunkSource.fetchChunk`, which awaits chunk arrival via
 * the existing chunk pipeline without blocking the main thread.
 */
export class NgChunkSource implements LibraryChunkSource {
  private currentSessionId: SessionId | undefined;
  private preloader: SessionChunkPreloader | undefined;
  private preloadAbort: AbortController | undefined;
  private preloadProgressUnsub: (() => void) | undefined;
  /**
   * Background preload progress for the active session, surfaced to the editing
   * topbar. Stable across sessions (the per-session `SessionChunkPreloader`
   * forwards into it); resets to `idle` on release.
   */
  readonly chunkLoadProgress = new WatchableValue<ChunkLoadProgressState>({
    kind: "idle",
  });
  /**
   * The session's painted (writable) layers. Their chunks take the preload's
   * pin budget before the reference layers'. Set by `EditSessionHost` before
   * each session opens.
   */
  writableLayerIds: ReadonlySet<LayerId> = new Set();

  /**
   * Optional handle to the host's committed-buffer store. When set, baseline
   * reads consult it before falling through to the data source — committed
   * chunks from a previous session become the starting state for the next
   * session's overlay. Wired by `EditSessionHost` at construction time.
   */
  commitTarget:
    | {
        getChunk(
          layerId: LayerId,
          resolution: string,
          chunkId: string,
        ): { bytes: ReadonlyChunkVoxelBuffer } | undefined;
      }
    | undefined;

  /**
   * The bytes the host has SAVED this session (TM-352). `readBaselineChunk`
   * consults it after `commitTarget` and before the datasource, so a saved
   * chunk reads as saved without evicting the rendered chunk. Session-lifetime:
   * the host clears it on teardown ({@link clearSavedBaseline}). Shares its
   * buffers with the library's history; see {@link SavedBaselineStore}.
   */
  private readonly savedBaseline = new SavedBaselineStore();

  constructor(
    private readonly layerManager: LayerManager,
    private readonly chunkManager: ChunkManager,
  ) {}

  /**
   * Record the bytes just written for `(layerId, resolution, chunkId)` as the
   * client's authoritative saved copy (TM-352). Called by the host right after
   * a save write. The bytes are KEPT, not copied (TM-373): they are the
   * library's immutable content-ref buffer, which no one may mutate.
   */
  recordSavedBaseline(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
    bytes: ReadonlyChunkVoxelBuffer,
  ): void {
    this.savedBaseline.set(
      savedBaselineKey(layerId, resolution, chunkId),
      bytes,
    );
  }

  /**
   * The client's stable saved copy of a chunk's bytes — used to RE-SEND on a
   * "Retry" after an unconfirmed save (the library is already rebaselined, so we
   * resend from here, not the overlay).
   */
  getSavedBytes(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
  ): ReadonlyChunkVoxelBuffer | undefined {
    return this.savedBaseline.get(
      savedBaselineKey(layerId, resolution, chunkId),
    );
  }

  /**
   * Drop the entire client-retained saved-baseline cache (TM-352). Called on
   * session exit: the saved bytes are a WITHIN-SESSION checkpoint (the snapshot
   * the user pressed "Save" on), useful while the session is alive for
   * verification, retry, and no-blink re-paint. After the session ends, keeping
   * them would let a stale snapshot shadow the backend on re-entry — reverting
   * the visible canvas and risking a silent overwrite of a concurrent external
   * edit. Re-entry must reconcile with the backend instead, so we clear here and
   * pair this with {@link invalidateDatasourceChunks}.
   */
  clearSavedBaseline(): void {
    this.savedBaseline.clear();
  }

  /**
   * Evict the given chunks from the datasource render cache so they re-download
   * fresh from the backend (TM-352). The main slice-view render path reads
   * `source.chunks` directly and never consults the saved-baseline cache, so
   * after a save the resident chunk still holds the PRE-save bytes; without this
   * eviction the canvas reverts to pre-save data on re-entry until a full page
   * reload. Used on session exit to replace the stale resident chunks with the
   * saved+verified bytes. Per-chunk eviction (no whole-source refetch storm);
   * a `(layerId, resolution)` that no longer resolves to a source is skipped.
   */
  invalidateDatasourceChunks(
    coords: readonly {
      readonly layerId: LayerId;
      readonly resolution: Resolution;
      readonly chunkCoord: ChunkCoord;
    }[],
  ): void {
    const keysBySource = new Map<VolumeChunkSource, string[]>();
    for (const { layerId, resolution, chunkCoord } of coords) {
      let source: VolumeChunkSource;
      try {
        source = this.resolveVolumeChunkSource(layerId, resolution);
      } catch {
        continue; // layer/source gone — nothing to evict
      }
      const key = makeChunkGridPosition(source, chunkCoord).join();
      const existing = keysBySource.get(source);
      if (existing === undefined) keysBySource.set(source, [key]);
      else existing.push(key);
    }
    for (const [source, keys] of keysBySource) {
      source.invalidateChunkCache(keys);
    }
  }

  /**
   * Evict EVERY resident chunk of the given `(layerId, resolution)` scopes, so
   * the next frame refetches them. Returns how many were evicted.
   *
   * This is "reload all chunks" as a tracer means it. {@link
   * invalidateDatasourceChunks} can only evict chunks the caller can name, and
   * the caller only ever knows the ones this session wrote — so a colleague's
   * work in a chunk you never painted stayed on screen as this session first
   * loaded it. The resident set needs no region arithmetic and is by definition
   * the only thing that can be showing stale data.
   *
   * The paint survives: it lives in the session overlay and in this layer's own
   * patch store, neither of which is a datasource chunk. What the user sees is
   * one round-trip of hole — the GPU patch is bound inside the base chunk's
   * draw call, so a chunk that is not resident draws neither.
   *
   * CALLERS MUST RESYNC THE PATCH MIRROR. A patched chunk's mask is derived
   * from the bytes this evicts, so leaving it alone composites two versions of
   * the same chunk; see `PatchMirror.resyncAfterRefetch`.
   */
  invalidateLoadedChunks(
    scopes: readonly {
      readonly layerId: LayerId;
      readonly resolution: Resolution;
    }[],
  ): number {
    let evicted = 0;
    for (const { layerId, resolution } of scopes) {
      let source: VolumeChunkSource;
      try {
        source = this.resolveVolumeChunkSource(layerId, resolution);
      } catch {
        continue; // layer/source gone — nothing to evict
      }
      const keys = Array.from(source.chunks.keys());
      if (keys.length === 0) continue;
      source.invalidateChunkCache(keys);
      evicted += keys.length;
    }
    return evicted;
  }

  async pinChunks(
    coords: readonly OverlayCoord[],
    signal?: AbortSignal,
  ): Promise<void> {
    // Tear down any preload still running for a previous session (the library
    // guarantees one session at a time, but be defensive on re-open).
    this.teardownPreload();
    if (signal?.aborted) {
      throw signal.reason;
    }
    // Stash the session id once any coord-bearing call comes in; releasePins
    // uses it to assert the lifecycle.
    if (coords.length > 0 && this.currentSessionId === undefined) {
      this.currentSessionId = sessionIdFromCoord(coords[0]);
    }

    // Kick off the background preload of every bbox chunk and resolve
    // immediately so the session goes ACTIVE and painting is allowed right
    // away. Reads that race the preload await their own fetch as before; the
    // preload simply warms (and pins) the chunk manager so later strokes don't
    // stall on a cold fetch.
    const abort = new AbortController();
    this.preloadAbort = abort;
    if (signal !== undefined) {
      if (signal.aborted) {
        abort.abort(signal.reason);
      } else {
        signal.addEventListener("abort", () => abort.abort(signal.reason), {
          once: true,
        });
      }
    }
    const { capacities } = this.chunkManager.chunkQueueManager;
    const { writableLayerIds } = this;
    const preloader = new SessionChunkPreloader(
      (layerId, resolution) =>
        this.resolveVolumeChunkSource(layerId, resolution),
      {
        poolSize: preloadPoolSizeFor(capacities.download),
        pinBudgetBytes: () => pinBudgetFor(capacities),
        pinsFirst: (layerId) => writableLayerIds.has(layerId),
      },
    );
    this.preloader = preloader;
    this.preloadProgressUnsub = preloader.progress.changed.add(() => {
      this.chunkLoadProgress.value = preloader.progress.value;
    });
    // Intentionally not awaited: the library awaits pinChunks before ACTIVE.
    void preloader.start(coords, abort.signal);
  }

  releasePins(sessionId: SessionId): void {
    if (
      this.currentSessionId !== undefined &&
      this.currentSessionId !== sessionId
    ) {
      // Mismatched release for a session we didn't track. Library contract
      // guarantees one session at a time; nothing to do.
      return;
    }
    this.teardownPreload();
    this.currentSessionId = undefined;
    this.writableLayerIds = new Set();
  }

  /** Abort the in-flight preload, release its pins, and reset progress. */
  private teardownPreload(): void {
    this.preloadAbort?.abort();
    this.preloadAbort = undefined;
    this.preloadProgressUnsub?.();
    this.preloadProgressUnsub = undefined;
    this.preloader?.release();
    this.preloader = undefined;
    this.chunkLoadProgress.value = { kind: "idle" };
  }

  async readBaselineChunk(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
    chunkCoord: ChunkCoord,
    signal?: AbortSignal,
  ): Promise<ReadonlyChunkVoxelBuffer> {
    const coord: OverlayCoord = { layerId, resolution, chunkId };
    if (signal?.aborted) {
      throw new ChunkReadAbortedError(coord);
    }
    // If a previous session committed this chunk (in-memory, client-side
    // only), use the committed bytes as the baseline so the new session's
    // overlay starts on top of the user's pending changes. Without this,
    // painting on top of a previously-committed voxel would silently revert
    // it to the raw data-source value when PatchMirror writes the new
    // chunk buffer (the overlay's "current" view never knew about the
    // commit).
    const committed = this.commitTarget?.getChunk(layerId, resolution, chunkId);
    if (committed !== undefined) {
      return committed.bytes;
    }
    // Then the client-retained saved bytes (TM-352): after a save we keep our
    // own copy of what was written, so a re-entry (same page, no reload) reads
    // the SAVED state as baseline instead of the datasource's stale chunk —
    // without evicting/refetching the rendered chunk (no blink). This is the
    // client's authoritative copy; it never depends on the backend being right.
    const saved = this.savedBaseline.get(
      savedBaselineKey(layerId, resolution, chunkId),
    );
    if (saved !== undefined) {
      return saved;
    }
    return this.readDatasourceBaseline(
      layerId,
      resolution,
      chunkId,
      chunkCoord,
      signal,
    );
  }

  /**
   * Read ONLY the datasource render base for a chunk — the decoded bytes the
   * base segmentation render layer shows from `source.chunks`, with NO
   * `commitTarget` / `savedBaseline` short-circuit.
   *
   * This is what {@link PatchMirror} must diff the overlay against to build the
   * per-voxel patched mask. The render composites the GPU patch where
   * `patched === 1` and falls back to the datasource chunk where `patched === 0`
   * — so the composite equals the overlay if and only if
   * `patched = (overlay !== datasourceBase)`. Diffing against the edit baseline
   * ({@link readBaselineChunk}, which returns the saved/committed bytes) instead
   * breaks that invariant the moment the edit baseline diverges from the
   * resident datasource chunk (i.e. right after a save, before the datasource
   * cache is refreshed on exit): the saved voxels then compare equal to the
   * baseline, drop out of the mask, and revert to the stale datasource value on
   * screen (TM-352).
   */
  async readDatasourceBaseline(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
    chunkCoord: ChunkCoord,
    signal?: AbortSignal,
  ): Promise<ReadonlyChunkVoxelBuffer> {
    const coord: OverlayCoord = { layerId, resolution, chunkId };
    if (signal?.aborted) {
      throw new ChunkReadAbortedError(coord);
    }
    let source: VolumeChunkSource;
    try {
      source = this.resolveVolumeChunkSource(layerId, resolution);
    } catch (cause) {
      throw new ChunkReadFailedError(coord, cause);
    }
    const chunkGridPosition = makeChunkGridPosition(source, chunkCoord);
    return fetchBaselineWithRetry(source, coord, chunkGridPosition, signal);
  }

  /**
   * {@link readDatasourceBaseline} for one box only (TM-373, PR 2): the
   * datasource render base of `box` (chunk-local, inclusive), as a dense
   * box-sized buffer. What the patch mirror reads on every brush move, instead
   * of decoding the whole chunk. Same retries and the same empty-chunk rule
   * (a sparse chunk reads as zeros; a fetch error is never an empty chunk).
   */
  async readDatasourceBaselineBox(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
    chunkCoord: ChunkCoord,
    box: ChunkVoxelBox,
    signal?: AbortSignal,
  ): Promise<ReadonlyChunkVoxelBuffer> {
    const coord: OverlayCoord = { layerId, resolution, chunkId };
    if (signal?.aborted) {
      throw new ChunkReadAbortedError(coord);
    }
    let source: VolumeChunkSource;
    try {
      source = this.resolveVolumeChunkSource(layerId, resolution);
    } catch (cause) {
      throw new ChunkReadFailedError(coord, cause);
    }
    const chunkGridPosition = makeChunkGridPosition(source, chunkCoord);
    return wrapAsReadonlyBuffer(
      await fetchWithRetry(source, coord, chunkGridPosition, signal, (chunk) =>
        readBaselineBox(source, chunk, box),
      ),
    );
  }

  /**
   * Fresh-read one chunk from the backend, decoded to per-voxel values, WITHOUT
   * evicting the resident/rendered chunk (TM-352 save verification). Routes
   * through `VolumeChunkSource.fetchFreshDecodedChunk` (a throwaway backend
   * download that never enters the chunk cache) and applies the SAME
   * `decodeBaselineChunk` as the baseline read, so the representation matches the
   * saved overlay bytes for a content-hash compare. Returns `undefined` when the
   * `(layerId, resolution)` no longer resolves to a source.
   */
  async readFreshDecoded(
    layerId: LayerId,
    resolution: Resolution,
    chunkCoord: ChunkCoord,
    signal?: AbortSignal,
  ): Promise<ReadonlyChunkVoxelBuffer | undefined> {
    let source: VolumeChunkSource;
    try {
      source = this.resolveVolumeChunkSource(layerId, resolution);
    } catch {
      return undefined;
    }
    const grid = makeChunkGridPosition(source, chunkCoord);
    // `fetchFreshDecodedChunk` returns the edge-clipped `chunkDataSize`; thread
    // it through so `decodeBaselineChunk` pads boundary chunks to the edit
    // chunk size (the resident-read path gets this from
    // `VolumeChunk.chunkDataSize`). Without it the fresh-decoded baseline would
    // be clipped-sized and mismatch the saved overlay bytes it's hashed against
    // (TM-353 / TM-352).
    const { data, chunkDataSize } = await source.fetchFreshDecodedChunk(
      grid,
      signal ?? new AbortController().signal,
    );
    const decoded = decodeBaselineChunk(source, {
      data,
      chunkDataSize,
    } as unknown as Chunk);
    return wrapAsReadonlyBuffer(decoded);
  }

  /**
   * One read-back attempt for the save verification (TM-352): fresh-read the
   * chunk and compare the OWNED part of it against what we sent.
   *
   * `owned` is the same {@link OwnedRegion} the write path used, carrying both
   * the sub-box and the hash of the bytes actually POSTed. Comparing through it
   * is what keeps write and verify in agreement — see the header of
   * `owned_chunk_write.ts`. Returns `true` only on a confirmed match; throws on
   * a read error (the caller retries), returns `false` on a value mismatch or
   * when the source no longer resolves.
   */
  async confirmChunkPersisted(
    layerId: LayerId,
    resolution: Resolution,
    chunkCoord: ChunkCoord,
    owned: OwnedRegion,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const readBack = await this.readFreshDecoded(
      layerId,
      resolution,
      chunkCoord,
      signal,
    );
    if (readBack === undefined) return false;
    // Hash ONLY the voxels this save wrote. A boundary chunk's other half
    // belongs to a neighbouring task that may have painted it since this
    // session opened, so hashing the whole chunk would compare our snapshot
    // against their newer data and never match — the save would sit in
    // "couldn't be confirmed" forever. `owned` is the same value the write
    // path used, so the two sides cannot disagree about what was sent.
    return ownedRegionHash(readBack.asView(), owned) === owned.hash;
  }

  private resolveVolumeChunkSource(
    layerId: LayerId,
    resolution: Resolution,
  ): VolumeChunkSource {
    const managedLayer = this.layerManager.getLayerByName(layerId);
    if (managedLayer === undefined) {
      throw new Error(`layer-not-found:${layerId}`);
    }
    const userLayer: UserLayer | null = managedLayer.layer;
    if (userLayer === null) {
      throw new Error(`layer-not-loaded:${layerId}`);
    }
    const found = findFirstVolumetricSubsource(userLayer);
    if (found === undefined) {
      throw new Error(`no-volumetric-data-source:${layerId}`);
    }
    const { volume, loadState } = found;
    const modelResolutionNm = extractModelResolutionNm(loadState);
    const sources = enumerateScaleSources(volume);
    for (const single of sources) {
      const voxelSizeNm = computeVoxelSizeNm(
        single.chunkSource.spec,
        single.chunkToMultiscaleTransform,
        modelResolutionNm,
      );
      if (resolutionFor(voxelSizeNm) === resolution) {
        return single.chunkSource;
      }
    }
    throw new Error(`no-matching-scale:${layerId}@${resolution}`);
  }
}

interface VolumetricFound {
  readonly volume: MultiscaleVolumeChunkSource;
  readonly loadState: LoadedLayerDataSource;
}

function findFirstVolumetricSubsource(
  userLayer: UserLayer,
): VolumetricFound | undefined {
  for (const layerDataSource of userLayer.dataSources) {
    const loadState = layerDataSource.loadState;
    if (loadState === undefined) continue;
    if ("error" in loadState && loadState.error !== undefined) continue;
    const loaded = loadState as LoadedLayerDataSource;
    for (const subsource of loaded.subsources) {
      const volume = subsource.subsourceEntry.subsource.volume;
      if (volume !== undefined) {
        return { volume, loadState: loaded };
      }
    }
  }
  return undefined;
}

function extractModelResolutionNm(
  loadState: LoadedLayerDataSource,
): readonly [number, number, number] {
  const outputSpace = loadState.dataSource.modelTransform.outputSpace;
  const { scales, units } = outputSpace;
  const result: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3 && i < scales.length; ++i) {
    const scale = scales[i];
    const unit = units[i];
    result[i] = unit === "m" ? scale * 1e9 : scale;
  }
  return result;
}

function enumerateScaleSources(
  volume: MultiscaleVolumeChunkSource,
): SliceViewSingleResolutionSource<VolumeChunkSource>[] {
  const rank = volume.rank;
  const displayRank = Math.min(rank, 3);
  const multiscaleToViewTransform = new Float32Array(displayRank * rank);
  for (let i = 0; i < displayRank; ++i) {
    multiscaleToViewTransform[i * displayRank + i] = 1;
  }
  const modelChannelDimensionIndices: number[] = rank > 3 ? [3] : [];
  const options: VolumeSourceOptions = {
    multiscaleToViewTransform,
    displayRank,
    modelChannelDimensionIndices,
  };
  // `getSources` returns `result[orientation][scale]`. Take the first
  // orientation's full scale list — same convention as the SliceView and
  // as `NgLayerMetadataSource.collectAllScaleSources`.
  const sourcesByOrientation = volume.getSources(options);
  return sourcesByOrientation[0] ?? [];
}

function computeVoxelSizeNm(
  spec: VolumeChunkSpecification,
  chunkToMultiscaleTransform: Float32Array,
  modelResolutionNm: readonly [number, number, number],
): readonly [number, number, number] {
  const rank = spec.rank;
  const stride = rank + 1;
  const result: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    const relativeScale = chunkToMultiscaleTransform[stride * i + i] || 1;
    result[i] = modelResolutionNm[i] * relativeScale;
  }
  return result;
}

function cloneTypedArray(buf: ChunkVoxelBuffer): ChunkVoxelBuffer {
  // Each ChunkVoxelBuffer variant supports .slice() returning the same kind.
  return (buf as { slice(): ChunkVoxelBuffer }).slice();
}

/**
 * Allocate an all-zero voxel buffer of the edit-session chunk shape
 * (`editChunkDataSize`) and the source's data type. Used when the underlying
 * data source is sparse: a missing chunk semantically means "no segments
 * here" / "value 0 everywhere", and the editing layer should let the brush
 * paint into it.
 */
function makeZeroFilledChunkBuffer(
  source: VolumeChunkSource,
): ChunkVoxelBuffer {
  const { chunkDataSize } = source.spec;
  const [sizeX, sizeY, sizeZ] = editChunkDataSize(source.spec);
  // `chunkDataSize` is 4D `[x, y, z, channels]` for volumes — the channel
  // count is its fourth component.
  const channels = chunkDataSize.length > 3 ? chunkDataSize[3] : 1;
  return makeZeroFilledVoxelBuffer(source, sizeX * sizeY * sizeZ * channels);
}

/** An all-zero buffer of `voxelCount` values of the source's data type. */
function makeZeroFilledVoxelBuffer(
  source: VolumeChunkSource,
  voxelCount: number,
): ChunkVoxelBuffer {
  switch (source.spec.dataType) {
    case DataType.UINT8:
      return new Uint8Array(voxelCount);
    case DataType.INT8:
      return new Int8Array(voxelCount);
    case DataType.UINT16:
      return new Uint16Array(voxelCount);
    case DataType.INT16:
      return new Int16Array(voxelCount);
    case DataType.UINT32:
      return new Uint32Array(voxelCount);
    case DataType.INT32:
      return new Int32Array(voxelCount);
    case DataType.UINT64:
      return new BigUint64Array(voxelCount);
    case DataType.FLOAT32:
      return new Float32Array(voxelCount);
    default:
      // Fallback: untyped bytes. Library readers tolerate the union; we
      // size for a single byte per voxel which is the safest minimum.
      return new Uint8Array(voxelCount);
  }
}

/**
 * Decode a compressed-segmentation chunk (`chunk.data` is the compressed block)
 * into a dense per-voxel buffer of the source's data type, at the chunk's
 * `clippedSize`. NG transcodes uint32/uint64 segmentation to this format for
 * rendering; the edit library needs the raw per-voxel values. `decodeChannels`
 * is NG's CPU decoder; it runs once per chunk per session (the overlay caches
 * the materialized slot), so the per-voxel cost is paid lazily and only for
 * edited chunks.
 *
 * The decode MUST use the chunk's edge-clipped extent, not the nominal
 * `chunkDataSize`: NG encodes a boundary chunk's compressed block for the
 * clipped data only, so decoding it with nominal dims runs the block-index math
 * off the end of the small compressed buffer (`offset is out of bounds`,
 * TM-353). The returned buffer is therefore clipped-sized; `decodeBaselineChunk`
 * pads it up to the edit-session chunk size.
 */
function decodeCompressedSegmentationChunk(
  source: VolumeChunkSource,
  data: ChunkVoxelBuffer,
  clippedSize: readonly [number, number, number],
): ChunkVoxelBuffer {
  const chunk = compressedBaselineChunk(source, data, clippedSize);
  if (chunk === undefined) return cloneTypedArray(data);
  // Unpadded here: `decodeBaselineChunk` pads, as for the plain clone above.
  return decodeCompressedBaseline({ ...chunk, editSize: clippedSize });
}

/**
 * The parts of a compressed-segmentation `data` block a decode needs, with a
 * COPY of the block (`fetchChunk` only guarantees `chunk.data` inside its
 * transform), or undefined when the source is not compressed segmentation.
 */
function compressedBaselineChunk(
  source: VolumeChunkSource,
  data: ChunkVoxelBuffer,
  clippedSize: readonly [number, number, number],
): CompressedBaselineChunk | undefined {
  const { dataType, compressedSegmentationBlockSize: blockSize } = source.spec;
  if (blockSize === undefined) return undefined;
  return {
    compressed: (data as Uint32Array).slice(),
    dataType: dataType === DataType.UINT64 ? "uint64" : "uint32",
    blockSize: [blockSize[0], blockSize[1], blockSize[2]],
    clippedSize,
    editSize: editChunkDataSize(source.spec),
  };
}

/**
 * The chunk's edge-clipped voxel extent `[x, y, z]`. NG clips boundary chunks
 * to the volume's data bounds, exposing the actual extent on
 * `VolumeChunk.chunkDataSize` (`sliceview/volume/frontend.ts`). Falls back to
 * the edit-session chunk size when the size is absent (e.g. the
 * `readFreshDecoded` `{ data }` path must supply it explicitly) — never larger
 * than what `padChunkToEditSize` pads to.
 */
function clippedSizeOf(
  source: VolumeChunkSource,
  chunk: Chunk,
): [number, number, number] {
  const clipped = (chunk as unknown as { chunkDataSize?: ArrayLike<number> })
    .chunkDataSize;
  const editSize = editChunkDataSize(source.spec);
  const dim = (i: number): number =>
    clipped !== undefined && clipped[i] !== undefined
      ? clipped[i]
      : editSize[i];
  return [dim(0), dim(1), dim(2)];
}

/**
 * Pad a chunk buffer decoded at the edge-clipped `clippedSize` into a buffer of
 * the edit-session chunk size (`editChunkDataSize`: the NOMINAL
 * `chunkDataSize`, except on an axis the volume fills with one chunk, where it
 * already equals the clipped extent — TM-373, PR 9a), with the clipped data in
 * the low corner and the remainder zero. Returns `decoded` unchanged when the
 * chunk already fills that size (every interior chunk — the common case).
 *
 * NG decodes boundary chunks clipped to the data extent, but the edit-session
 * library indexes chunk slots with its own `chunkDataSize` (the same
 * `editChunkDataSize`, via `NgLayerMetadataSource`; its `writeRegion`/overlay
 * copy uses those strides), so every baseline the library sees must be that
 * size. Handing it a clipped buffer makes the strided copy run off the end
 * (`offset is out of bounds`) and breaks `PatchMirror.fuseOverlayIntoChunk`'s
 * equal-length invariant (overlay/baseline clipped vs. patch chunk) — the two
 * TM-353 crashes. Padding fixes both without any change to the mirror,
 * patch-texture cache, or shader: the patch texture takes the same size and
 * strides (`uPatchStrides`), and the base render clamps its sample to the
 * clipped `uChunkDataSize`.
 */
function padChunkToEditSize(
  source: VolumeChunkSource,
  decoded: ChunkVoxelBuffer,
  clippedSize: readonly [number, number, number],
): ChunkVoxelBuffer {
  return padToEditSize(
    decoded as Uint8Array,
    clippedSize,
    editChunkDataSize(source.spec),
  ) as ChunkVoxelBuffer;
}

/**
 * A baseline fetch is retried before being surfaced as a hard read failure: a
 * transient network/RPC hiccup must NOT be mistaken for an empty chunk (see
 * `fetchBaselineWithRetry`). Total attempts, and the backoff before each retry
 * — the array has one entry fewer than `BASELINE_FETCH_ATTEMPTS` so the final
 * attempt has no trailing wait.
 */
const BASELINE_FETCH_ATTEMPTS = 3;
const BASELINE_FETCH_BACKOFF_MS: readonly number[] = [50, 150];

/**
 * Snapshot a fetched chunk into a baseline voxel buffer. The outcome taxonomy
 * has only ONE empty-baseline case:
 *   • `chunk.data == null` after a SUCCESSFUL fetch: the chunk is sparse /
 *     absent. The kvStore read returns `undefined` for a 404/403 and the volume
 *     download leaves `data` null without throwing (see
 *     `PrecomputedVolumeChunkSource.download` and `handleThrowIfMissing`). This
 *     is the only definitive "no voxels here" signal, so we zero-fill it and
 *     let the brush paint into it.
 *   • a THROWN error never reaches here — it's handled by the retry loop in
 *     `fetchBaselineWithRetry`; a genuine fetch failure is NEVER an empty chunk.
 *
 * Exported for `baseline_chunk_costs.benchmark.ts` (TM-373), which times it on
 * 4096² chunks.
 */
export function decodeBaselineChunk(
  source: VolumeChunkSource,
  chunk: Chunk,
): ChunkVoxelBuffer {
  const raw = (chunk as unknown as { data?: ChunkVoxelBuffer | null }).data;
  if (raw == null) {
    return makeZeroFilledChunkBuffer(source);
  }
  // NG decodes boundary chunks clipped to the volume's data bounds, so `raw`
  // (and the compressed decode below) can be smaller than the chunk the edit
  // library indexes slots with (`editChunkDataSize`), so every decoded baseline
  // is padded up to that size before it leaves here (TM-353, TM-373).
  const clippedSize = clippedSizeOf(source, chunk);
  // Neuroglancer transcodes uint32/uint64 SEGMENTATION volumes to the
  // compressed-segmentation format for GPU rendering, so `chunk.data` is the
  // COMPRESSED block (a small Uint32Array), not the per-voxel values the edit
  // library expects. Decode it back to a dense, per-voxel buffer; otherwise the
  // library writes 8 bytes/voxel past the end of the tiny compressed buffer
  // (`offset is out of bounds`) and the baseline values are garbage. Plain
  // (non-transcoded) chunks are snapshotted as-is — `fetchChunk` only
  // guarantees `chunk.data` inside this callback, so we clone for a stable view.
  const decoded =
    source.spec.compressedSegmentationBlockSize !== undefined
      ? decodeCompressedSegmentationChunk(source, raw, clippedSize)
      : cloneTypedArray(raw);
  return padChunkToEditSize(source, decoded, clippedSize);
}

/**
 * The voxels of `box` (chunk-local, inclusive, within the edit-session chunk)
 * of a fetched chunk, as a dense box-sized buffer of the source's data type —
 * the same values `decodeBaselineChunk` gives there, without decoding or
 * copying the rest of the chunk (TM-373, PR 2). Outside the clipped extent the
 * values are 0, as the padding of an edge chunk; a sparse chunk is all zero.
 *
 * Single-channel only, like the patch mirror it serves.
 *
 * Exported for `baseline_chunk_costs.benchmark.ts`.
 */
export function readBaselineBox(
  source: VolumeChunkSource,
  chunk: Chunk,
  box: ChunkVoxelBox,
): ChunkVoxelBuffer {
  const out = makeZeroFilledVoxelBuffer(source, boxVoxelCount(box));
  const raw = (chunk as unknown as { data?: ChunkVoxelBuffer | null }).data;
  if (raw == null) return out;
  const clippedSize = clippedSizeOf(source, chunk);
  const { compressedSegmentationBlockSize } = source.spec;
  if (compressedSegmentationBlockSize !== undefined) {
    readCompressedSegmentationBox(
      raw as Uint32Array,
      clippedSize,
      compressedSegmentationBlockSize,
      box,
      out as Uint32Array | BigUint64Array,
    );
    return out;
  }
  copyRawBox(raw, clippedSize, box, out);
  return out;
}

/**
 * Copy the rows of `box` that lie inside the clipped extent from a raw chunk
 * (clipped layout) into a box-sized buffer. As in `padChunkToEditSize`, the
 * `Uint8Array` casts only satisfy the typed-array union; `.set` / `.subarray`
 * work element-wise for every variant.
 */
function copyRawBox(
  raw: ChunkVoxelBuffer,
  clippedSize: readonly [number, number, number],
  box: ChunkVoxelBox,
  out: ChunkVoxelBuffer,
): void {
  const [clippedX, clippedY, clippedZ] = clippedSize;
  const [boxSizeX, boxSizeY] = boxSize(box);
  const lastX = Math.min(box.x1, clippedX - 1);
  const lastY = Math.min(box.y1, clippedY - 1);
  const lastZ = Math.min(box.z1, clippedZ - 1);
  if (lastX < box.x0) return;
  const rowLength = lastX - box.x0 + 1;
  const source = raw as Uint8Array;
  const target = out as Uint8Array;
  for (let z = box.z0; z <= lastZ; z++) {
    for (let y = box.y0; y <= lastY; y++) {
      const rawRowStart = (z * clippedY + y) * clippedX + box.x0;
      const boxRowStart = ((z - box.z0) * boxSizeY + (y - box.y0)) * boxSizeX;
      target.set(
        source.subarray(rawRowStart, rawRowStart + rowLength),
        boxRowStart,
      );
    }
  }
}

/**
 * Read a chunk's baseline bytes, retrying on a genuine fetch error and then
 * propagating it as `ChunkReadFailedError` rather than masking it as a
 * false-empty baseline. Masking the error would silently corrupt the session:
 * a full ERASE over a false-empty baseline produces no byte difference, so the
 * chunk never goes dirty, the Save button stays disabled, and the erasure is
 * lost on reload; a PAINT drops the real underlying voxels on save. A sparse /
 * absent chunk is NOT an error — it resolves with null data and zero-fills via
 * `decodeBaselineChunk`. Exported for unit testing.
 */
export async function fetchBaselineWithRetry(
  source: VolumeChunkSource,
  coord: OverlayCoord,
  chunkGridPosition: Float32Array,
  signal: AbortSignal | undefined,
): Promise<ReadonlyChunkVoxelBuffer> {
  const snapshot = await fetchWithRetry(
    source,
    coord,
    chunkGridPosition,
    signal,
    (chunk) => snapshotForDecode(source, chunk),
  );
  if (!isCompressedSnapshot(snapshot)) return wrapAsReadonlyBuffer(snapshot);
  // The decode of a 4096² uint64 chunk is ~400 ms of main-thread work; only
  // the copy of its compressed block happened inside the fetch (TM-373).
  let decoded: ChunkVoxelBuffer;
  try {
    decoded = await decodeBaselineOffMainThread(snapshot);
  } catch (cause) {
    throw new ChunkReadFailedError(coord, cause);
  }
  if (signal?.aborted) throw new ChunkReadAbortedError(coord);
  return wrapAsReadonlyBuffer(decoded);
}

type BaselineSnapshot = ChunkVoxelBuffer | CompressedBaselineChunk;

function isCompressedSnapshot(
  snapshot: BaselineSnapshot,
): snapshot is CompressedBaselineChunk {
  return "compressed" in snapshot;
}

/**
 * What `fetchBaselineWithRetry` keeps of a fetched chunk inside the fetch:
 * the compressed block to decode afterwards, or — for anything else (a plain
 * dtype, a sparse chunk) — the finished baseline, exactly as
 * {@link decodeBaselineChunk} gives it.
 */
function snapshotForDecode(
  source: VolumeChunkSource,
  chunk: Chunk,
): BaselineSnapshot {
  const raw = (chunk as unknown as { data?: ChunkVoxelBuffer | null }).data;
  if (raw == null) return decodeBaselineChunk(source, chunk);
  const compressed = compressedBaselineChunk(
    source,
    raw,
    clippedSizeOf(source, chunk),
  );
  return compressed ?? decodeBaselineChunk(source, chunk);
}

/**
 * The retry loop of {@link fetchBaselineWithRetry} around any snapshot of the
 * fetched chunk: `snapshot` runs inside `fetchChunk`'s transform, the only
 * point where `chunk.data` is guaranteed in memory.
 */
async function fetchWithRetry<Snapshot>(
  source: VolumeChunkSource,
  coord: OverlayCoord,
  chunkGridPosition: Float32Array,
  signal: AbortSignal | undefined,
  snapshot: (chunk: Chunk) => Snapshot,
): Promise<Snapshot> {
  const fetchSignal = signal ?? new AbortController().signal;
  let lastError: unknown;
  for (let attempt = 0; attempt < BASELINE_FETCH_ATTEMPTS; ++attempt) {
    if (signal?.aborted) {
      throw new ChunkReadAbortedError(coord);
    }
    try {
      return await source.fetchChunk(chunkGridPosition, snapshot, {
        signal: fetchSignal,
      });
    } catch (cause) {
      if (signal?.aborted) {
        throw new ChunkReadAbortedError(coord);
      }
      lastError = cause;
      const backoffMs = BASELINE_FETCH_BACKOFF_MS[attempt];
      if (backoffMs !== undefined) {
        await delayWithAbort(backoffMs, signal);
      }
    }
  }
  // Retries exhausted on a genuine error. Surface it instead of silently
  // returning a false-empty baseline.
  console.warn(
    `[edit-session:overlay] baseline fetch failed for ` +
      `${coord.layerId}@resolution${coord.resolution}:${coord.chunkId} after ` +
      `${BASELINE_FETCH_ATTEMPTS} attempts; propagating as a read failure`,
    lastError,
  );
  throw new ChunkReadFailedError(coord, lastError);
}

/**
 * Resolve after `ms`, or early if `signal` aborts — it always RESOLVES (never
 * rejects). The caller re-checks `signal.aborted` at the top of its retry loop
 * and throws the appropriate `ChunkReadAbortedError` there, so this helper
 * stays a plain delay with no error semantics of its own.
 */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function wrapAsReadonlyBuffer(
  data: ChunkVoxelBuffer,
): ReadonlyChunkVoxelBuffer {
  return {
    byteLength: data.byteLength,
    asView(): ChunkVoxelBuffer {
      return data;
    },
  };
}

function sessionIdFromCoord(_coord: OverlayCoord): SessionId | undefined {
  // The library's `pinChunks` contract does not pass a SessionId. We leave
  // this returning undefined and rely on `releasePins` to clear state on
  // any subsequent release call (the library guarantees exactly one session
  // at a time, see edit-session.runtime.ts:313, :513).
  return undefined;
}

/** `(layerId, resolution, chunkId)` key for the saved-baseline store. */
function savedBaselineKey(
  layerId: LayerId,
  resolution: Resolution,
  chunkId: ChunkId,
): string {
  return `${layerId}|${resolution}|${chunkId}`;
}
