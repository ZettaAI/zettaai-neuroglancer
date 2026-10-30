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
 * @file The live painted-volume preview of one writable layer (plan §8.1).
 *
 * Keeps a class texture of the session region equal to the composite the 2D
 * layer draws — datasource baseline where nothing is patched, the patch
 * elsewhere — restricted to the segments whose meshes NG would draw (§3.12).
 * Three kinds of work feed it:
 *
 * - a full recompute of the region (on creation, a selection change,
 *   `clearAll`, a datasource refetch), read in the background by
 *   `PaintedVolumeRegionFill`;
 * - stroke deltas from `LocalPatchStore.chunkChanged`, recorded synchronously
 *   and composited against cached baselines;
 * - view-only changes (colours, the hover highlight, 3D opacity, display
 *   scale, the cursor window), which never touch the texture.
 *
 * Texture work runs on the preview's own animation frame within a voxel
 * budget and reschedules itself while work remains — `store.changed` is not a
 * reliable wake-up, since `flushImmediately` fires it synchronously (§3.8).
 * The preview never holds the edit session: everything it needs from it is
 * passed in at construction, and a new region means a new preview (§3.9).
 */

import type {
  ChunkId,
  LayerMetadata,
  Logger,
  Resolution,
  SessionVoxelBounds,
} from "@zettaai/edit-session";
import { ChunkGrid, scaleFor } from "@zettaai/edit-session";

import type { CursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import { resolveCursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";
import type { ChunkKey } from "#src/editing/local_patch_source.js";
import type {
  LocalPatchStore,
  PatchChunkChange,
} from "#src/editing/local_patch_store.js";
import type {
  BaselineCacheLimits,
  PaintedVolumeBaselineReader,
} from "#src/editing/painted_volume/painted_volume_baseline_cache.js";
import { PaintedVolumeBaselineCache } from "#src/editing/painted_volume/painted_volume_baseline_cache.js";
import { paintedVolumeCursorFootprint } from "#src/editing/painted_volume/painted_volume_cursor_window.js";
import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import {
  PAINTED_VOLUME_BYTES_PER_TEXEL,
  planPaintedVolumeExtent,
} from "#src/editing/painted_volume/painted_volume_extent.js";
import type {
  PaintedVolumeFrameState,
  PaintedVolumeGpu,
  PaintedVolumeGpuFactory,
} from "#src/editing/painted_volume/painted_volume_gpu.js";
import type {
  BaselineVoxelView,
  PaintedVolumeChunkVoxels,
} from "#src/editing/painted_volume/painted_volume_occupancy.js";
import {
  chunkHasShownVoxel,
  writeOccupancyForBox,
} from "#src/editing/painted_volume/painted_volume_occupancy.js";
import { PaintedVolumeOccupiedChunks } from "#src/editing/painted_volume/painted_volume_occupied_chunks.js";
import {
  PaintedVolumePendingChanges,
  isWholeChunkBox,
  voxelCountOf,
  wholeChunkBox,
} from "#src/editing/painted_volume/painted_volume_pending_changes.js";
import type {
  RegionFillChunk,
  RegionFillProgress,
} from "#src/editing/painted_volume/painted_volume_region_fill.js";
import {
  PaintedVolumeRegionFill,
  chunkIdOfKey,
} from "#src/editing/painted_volume/painted_volume_region_fill.js";
import { PaintedVolumeSegmentPalette } from "#src/editing/painted_volume/painted_volume_segment_palette.js";
import type { PaintedVolumeShownSegments } from "#src/editing/painted_volume/painted_volume_shown_segments.js";
import { paintedVolumeShownSegments } from "#src/editing/painted_volume/painted_volume_shown_segments.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import {
  buildTexelToDisplayMatrix,
  chunkBoxToTexelBox,
} from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import type { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import {
  onTemporaryVisibleSegmentsStateChanged,
  onVisibleSegmentsStateChanged,
} from "#src/segmentation_display_state/base.js";
import type {
  SegmentationDisplayState,
  SegmentationDisplayStateWithAlpha,
} from "#src/segmentation_display_state/frontend.js";
import { registerCallbackWhenSegmentationDisplayStateChanged } from "#src/segmentation_display_state/frontend.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue, registerNestedSync } from "#src/trackable_value.js";
import type { DebouncedFunction } from "#src/util/animation_frame_debounce.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import type { vec3 } from "#src/util/geom.js";
import { mat4 } from "#src/util/geom.js";

type Triple = readonly [number, number, number];

/** The `BrushCursorState` watchables the cursor window reads. */
export interface PaintedVolumeCursorSource {
  readonly visible: WatchableValueInterface<boolean>;
  readonly worldCenter: WatchableValueInterface<vec3 | undefined>;
  readonly radiusVoxels: WatchableValueInterface<number>;
}

export interface PaintedVolumePreviewOptions {
  readonly createGpu: PaintedVolumeGpuFactory;
  /** `R_preview`: the layer's first session resolution (§3.10). */
  readonly resolution: Resolution;
  /** From `SessionRegionSnapshot.boundsFor`, exclusive `hi`. */
  readonly regionBounds: SessionVoxelBounds;
  readonly metadata: LayerMetadata;
  readonly store: LocalPatchStore;
  readonly displayState: SegmentationDisplayStateWithAlpha;
  readonly displayInfo: WatchableValueInterface<DisplayDimensionRenderInfo>;
  readonly readBaseline: PaintedVolumeBaselineReader;
  readonly cursor: PaintedVolumeCursorSource;
  readonly maxTextureDim: number;
  readonly budgetBytes: number;
  readonly logger: Logger;
  readonly voxelBudgetPerFrame?: number;
  /** Wall-clock cap on one frame's region-fill work. */
  readonly fillFrameBudgetMs?: number;
  readonly maxReadsInFlight?: number;
  readonly baselineCacheLimits?: BaselineCacheLimits;
}

export type PaintedVolumeUnavailableReason =
  /** No allowed downsampling fits the texture size limit and memory budget. */
  "region-too-large" | "texture-allocation-failed";

export type PaintedVolumePreviewStatus =
  | {
      readonly kind: "unavailable";
      readonly reason: PaintedVolumeUnavailableReason;
    }
  | {
      readonly kind: "live";
      readonly fill: RegionFillProgress;
      readonly textureBytes: number;
      /** Voxels per texel; above 1 the preview is downsampled. */
      readonly factor: Triple;
    };

/**
 * Plan §3.12: a 1024×1024×64 region in ~17 frames. The composite kernel runs
 * at ~6 ns per voxel (`edit_painted_volume.perf.ts`), ~25 ms at this budget.
 */
export const DEFAULT_VOXEL_BUDGET_PER_FRAME = 4 * 1024 * 1024;

/**
 * Plan §9.3: no region-fill frame over 50 ms. Voxels alone cannot bound a
 * frame: taking a landed chunk starts the next read, whose synchronous part
 * decodes a resident chunk on this frame (~9 ms for 512×512 uint64). The perf
 * test measured 72 ms frames under the voxel budget alone; this leaves room
 * for one more chunk past the cap.
 */
export const DEFAULT_FILL_FRAME_BUDGET_MS = 24;

export class PaintedVolumePreview extends RefCounted {
  readonly status: WatchableValueInterface<PaintedVolumePreviewStatus>;
  private readonly sync: PaintedVolumeTextureSync | undefined;

  constructor(options: PaintedVolumePreviewOptions) {
    super();
    const extent = planExtent(options);
    if (extent === undefined) {
      // No control shows the preview's state, so the log is where it says why
      // the 3D panel stays empty.
      options.logger.warn(
        "editing",
        "3D preview: the session region is too large to preview at any allowed downsampling",
        { budgetBytes: options.budgetBytes },
      );
      this.status = new WatchableValue<PaintedVolumePreviewStatus>(
        unavailable("region-too-large"),
      );
      return;
    }
    const frame: PaintedVolumeFrameState = {
      extent,
      texelToDisplay: undefined,
      occupiedBox: undefined,
      cursorFootprint: undefined,
      visible: true,
      segmentOfClass: () => undefined,
    };
    const gpu = options.createGpu(frame);
    if (!gpu.allocate(extent.textureSize)) {
      gpu.dispose();
      this.status = new WatchableValue<PaintedVolumePreviewStatus>(
        unavailable("texture-allocation-failed"),
      );
      return;
    }
    this.sync = this.registerDisposer(
      new PaintedVolumeTextureSync(options, frame, gpu),
    );
    this.status = this.sync.status;
  }

  /** `undefined` while unavailable; attach with `addRef()`. */
  get renderLayer(): PerspectiveViewRenderLayer | undefined {
    return this.sync?.gpu.renderLayer;
  }

  /**
   * The host reloaded the datasource chunks (save, discard, conflict reload):
   * recompute the region from the new bytes.
   */
  onDatasourceRefetched(): void {
    this.sync?.onDatasourceRefetched();
  }
}

function planExtent(
  options: PaintedVolumePreviewOptions,
): PaintedVolumeExtent | undefined {
  const scale = scaleFor(options.metadata, options.resolution);
  return planPaintedVolumeExtent(
    options.regionBounds,
    scale.chunkDataSize,
    scale.voxelOffset,
    options.maxTextureDim,
    options.budgetBytes,
  );
}

function unavailable(
  reason: PaintedVolumeUnavailableReason,
): PaintedVolumePreviewStatus {
  return { kind: "unavailable", reason };
}

/** Keeps an allocated texture equal to the shown composite. */
class PaintedVolumeTextureSync extends RefCounted {
  readonly status: WatchableValue<PaintedVolumePreviewStatus>;

  private readonly extent: PaintedVolumeExtent;
  private readonly grid: ChunkGrid;
  private readonly chunkSize: Triple;
  private readonly regionChunkIds: readonly ChunkId[];
  private readonly voxelBudgetPerFrame: number;
  private readonly fillFrameBudgetMs: number;

  private readonly palette = new PaintedVolumeSegmentPalette();
  private readonly pending = new PaintedVolumePendingChanges();
  /** Deltas whose baseline is still being read. */
  private readonly waitingForBaseline = new PaintedVolumePendingChanges();
  private readonly occupied = new PaintedVolumeOccupiedChunks();
  private readonly baselines: PaintedVolumeBaselineCache;
  private readonly fill: PaintedVolumeRegionFill;
  private readonly scheduleFlush: DebouncedFunction;

  private shown: PaintedVolumeShownSegments;
  private cursorFrame: CursorVoxelFrame | undefined;
  private scratch: Uint8Array | undefined;

  constructor(
    private readonly options: PaintedVolumePreviewOptions,
    private readonly frame: PaintedVolumeFrameState,
    readonly gpu: PaintedVolumeGpu,
  ) {
    super();
    const { metadata, resolution, regionBounds, logger } = options;
    this.extent = frame.extent;
    frame.segmentOfClass = (segmentClass) =>
      this.palette.segmentOfClass(segmentClass);
    this.grid = ChunkGrid.fromLayer(metadata, resolution);
    this.chunkSize = scaleFor(metadata, resolution).chunkDataSize;
    this.regionChunkIds = this.grid.chunkIdsOverlappingBox(
      [regionBounds.loX, regionBounds.loY, regionBounds.loZ],
      [
        regionBounds.hiX - regionBounds.loX,
        regionBounds.hiY - regionBounds.loY,
        regionBounds.hiZ - regionBounds.loZ,
      ],
    );
    this.voxelBudgetPerFrame =
      options.voxelBudgetPerFrame ?? DEFAULT_VOXEL_BUDGET_PER_FRAME;
    this.fillFrameBudgetMs =
      options.fillFrameBudgetMs ?? DEFAULT_FILL_FRAME_BUDGET_MS;
    this.shown = paintedVolumeShownSegments(options.displayState);

    this.scheduleFlush = animationFrameDebounce(() => this.flush());
    this.baselines = new PaintedVolumeBaselineCache(
      options.readBaseline,
      () => this.onBaselineLoaded(),
      logger,
      options.baselineCacheLimits,
    );
    this.fill = new PaintedVolumeRegionFill(
      options.readBaseline,
      this.scheduleFlush,
      logger,
      options.maxReadsInFlight,
    );
    this.status = new WatchableValue(this.liveStatus());

    this.registerDisposer(() => {
      this.scheduleFlush.cancel();
      this.fill.cancel();
      this.baselines.clear();
      gpu.dispose();
    });
    this.subscribe();
    this.updateViewPlacement();
    this.updateVisibility();
    this.uploadPalette();
    this.startFullRecompute();
  }

  onDatasourceRefetched(): void {
    this.baselines.clear();
    this.waitingForBaseline.clear();
    this.startFullRecompute();
  }

  private subscribe(): void {
    const { store, displayState, displayInfo, cursor } = this.options;
    this.registerDisposer(
      store.chunkChanged.add((change) => this.onPatchChanged(change)),
    );
    this.registerDisposer(store.changed.add(this.scheduleFlush));
    this.registerDisposer(
      displayInfo.changed.add(() => this.updateViewPlacement()),
    );
    watchSegmentSelection(this, displayState, () =>
      this.onShownSegmentsChanged(),
    );
    // The mesh layer's own redraw triggers, so colours and the hover highlight
    // follow it exactly; they only re-upload the palette.
    registerCallbackWhenSegmentationDisplayStateChanged(
      displayState,
      this,
      () => this.refreshColors(),
    );
    this.registerDisposer(
      displayState.objectAlpha.changed.add(() => this.updateVisibility()),
    );
    this.registerDisposer(this.palette.changed.add(() => this.uploadPalette()));
    for (const watchable of [
      cursor.visible,
      cursor.worldCenter,
      cursor.radiusVoxels,
    ]) {
      this.registerDisposer(
        watchable.changed.add(() => this.updateCursorWindow()),
      );
    }
    this.registerDisposer(
      this.fill.progress.changed.add(() => {
        this.status.value = this.liveStatus();
      }),
    );
  }

  private liveStatus(): PaintedVolumePreviewStatus {
    const [sizeX, sizeY, sizeZ] = this.extent.textureSize;
    return {
      kind: "live",
      fill: this.fill.progress.value,
      textureBytes: sizeX * sizeY * sizeZ * PAINTED_VOLUME_BYTES_PER_TEXEL,
      factor: this.extent.factor,
    };
  }

  // --- Events -------------------------------------------------------------

  private onPatchChanged(change: PatchChunkChange): void {
    if (change.kind === "all-cleared") {
      // No patches left: the composite is the baseline everywhere.
      this.baselines.clear();
      this.pending.clear();
      this.waitingForBaseline.clear();
      this.startFullRecompute();
      return;
    }
    const { key, box } = change;
    if (box === null && !this.options.store.source.chunks.has(key)) {
      // `clearChunk`: the patch is gone, and so is the reason to cache.
      this.baselines.evict(key);
      this.waitingForBaseline.delete(key);
    }
    this.pending.note(key, box);
    this.scheduleFlush();
  }

  private onBaselineLoaded(): void {
    for (const { key, box } of this.waitingForBaseline.drain(
      Infinity,
      this.chunkSize,
    )) {
      this.pending.note(key, box);
    }
    this.scheduleFlush();
  }

  /**
   * Segments that left the set vanish at once through the palette; the texels
   * are rewritten by a full recompute that keeps the old content on screen
   * until each chunk is redone, so nothing blinks (§3.12).
   */
  private onShownSegmentsChanged(): void {
    this.shown = paintedVolumeShownSegments(this.options.displayState);
    this.refreshColors();
    this.startFullRecompute();
  }

  private startFullRecompute(): void {
    this.fill.start(this.regionChunkIds);
  }

  // --- View-only updates --------------------------------------------------

  private refreshColors(): void {
    this.palette.refreshColors(this.options.displayState, this.shown);
  }

  /** Like the mesh layer, draw nothing at a 3D opacity of 0. */
  private updateVisibility(): void {
    this.frame.visible = this.options.displayState.objectAlpha.value > 0;
    this.gpu.requestRedraw();
  }

  private uploadPalette(): void {
    this.gpu.uploadPalette(this.palette.colors);
    this.gpu.requestRedraw();
  }

  private updateViewPlacement(): void {
    const { resolution, displayInfo } = this.options;
    this.cursorFrame = resolveCursorVoxelFrame(resolution, displayInfo.value);
    this.frame.texelToDisplay =
      this.cursorFrame === undefined
        ? undefined
        : buildTexelToDisplayMatrix(
            mat4.create(),
            this.cursorFrame,
            this.extent,
          );
    this.updateCursorWindow();
  }

  private updateCursorWindow(): void {
    const { cursor } = this.options;
    this.frame.cursorFootprint = paintedVolumeCursorFootprint(
      {
        visible: cursor.visible.value,
        worldCenter: cursor.worldCenter.value,
        radiusVoxels: cursor.radiusVoxels.value,
      },
      this.cursorFrame,
    );
    this.gpu.requestRedraw();
  }

  // --- Texture work, on the preview's own frame ---------------------------

  private flush(): void {
    const classCountBefore = this.palette.classCount;
    const deltaVoxels = this.applyPendingChanges(this.voxelBudgetPerFrame);
    const fillStart = paintProfiler.enabled ? performance.now() : 0;
    const fillVoxels = this.applyLandedChunks(
      this.voxelBudgetPerFrame - deltaVoxels,
    );
    // One call per frame of fill work: `maxMs` is the worst frame (§9.3).
    if (paintProfiler.enabled && fillVoxels > 0) {
      paintProfiler.record(
        "7.preview.regionFill",
        performance.now() - fillStart,
      );
    }
    // New classes have no colour until the palette is refreshed.
    if (this.palette.classCount !== classCountBefore) this.refreshColors();
    this.frame.occupiedBox = this.occupied.occupiedBox;
    if (deltaVoxels + fillVoxels > 0) this.gpu.requestRedraw();
    if (this.pending.size > 0 || this.fill.hasLanded) this.scheduleFlush();
  }

  /** Stroke deltas first: they are what the user is looking at. */
  private applyPendingChanges(voxelBudget: number): number {
    let spentVoxels = 0;
    // A change still waiting for its baseline costs nothing, so keep draining.
    while (spentVoxels < voxelBudget && this.pending.size > 0) {
      for (const { key, box } of this.pending.drain(
        voxelBudget - spentVoxels,
        this.chunkSize,
      )) {
        spentVoxels += this.applyChange(key, box);
      }
    }
    return spentVoxels;
  }

  private applyChange(key: ChunkKey, box: ChunkVoxelBox): number {
    const chunkId = chunkIdOfKey(key);
    const origin = this.grid.chunkOriginOf(chunkId);
    const chunkTexelBox = this.chunkTexelBoxOf(origin);
    if (chunkTexelBox === undefined) return 0;
    const baseline = this.baselines.lookup(key, chunkId);
    if (baseline.kind === "loading") {
      this.waitingForBaseline.note(key, box);
      return 0;
    }
    // A failed read was logged by the cache; the next change retries it.
    if (baseline.kind === "failed") return 0;
    this.writeChunkBox(
      key,
      this.chunkVoxelsOf(key, origin, baseline.view),
      box,
      chunkTexelBox,
    );
    return voxelCountOf(box);
  }

  private applyLandedChunks(voxelBudget: number): number {
    let spentVoxels = 0;
    const deadline = performance.now() + this.fillFrameBudgetMs;
    for (let taken = 0; spentVoxels < voxelBudget; ++taken) {
      // The first chunk is always taken, so a fill makes progress every frame.
      if (taken > 0 && performance.now() >= deadline) break;
      const chunk = this.fill.takeReady();
      if (chunk === undefined) break;
      spentVoxels += this.applyLandedChunk(chunk);
    }
    return spentVoxels;
  }

  private applyLandedChunk({
    chunkId,
    key,
    baseline,
  }: RegionFillChunk): number {
    const origin = this.grid.chunkOriginOf(chunkId);
    const chunkTexelBox = this.chunkTexelBoxOf(origin);
    if (chunkTexelBox === undefined) return 0;
    const box = wholeChunkBox(this.chunkSize);
    this.writeChunkBox(
      key,
      this.chunkVoxelsOf(key, origin, baseline),
      box,
      chunkTexelBox,
    );
    return voxelCountOf(box);
  }

  /** Composite `box` into the texture and track whether the chunk is occupied. */
  private writeChunkBox(
    key: ChunkKey,
    chunk: PaintedVolumeChunkVoxels,
    box: ChunkVoxelBox,
    chunkTexelBox: TexelBox,
  ): void {
    const profiling = paintProfiler.enabled;
    const occupancyStart = profiling ? performance.now() : 0;
    const write = writeOccupancyForBox(
      chunk,
      box,
      this.extent,
      this.shown,
      this.palette,
      this.scratch,
    );
    if (profiling) {
      paintProfiler.record(
        "7.preview.occupancy",
        performance.now() - occupancyStart,
      );
    }
    if (write === undefined) return;
    if (write.bytes.buffer !== this.scratch?.buffer) {
      this.scratch = write.bytes;
    }
    const uploadStart = profiling ? performance.now() : 0;
    this.gpu.uploadBox(write.texelBox, write.bytes);
    if (profiling) {
      paintProfiler.record("7.preview.upload", performance.now() - uploadStart);
    }
    // An empty sub-box says nothing about the rest of the chunk.
    const occupied =
      write.occupied ||
      (!isWholeChunkBox(box, this.chunkSize) &&
        chunkHasShownVoxel(chunk, this.shown));
    this.occupied.mark(key, chunkTexelBox, occupied);
  }

  private chunkVoxelsOf(
    key: ChunkKey,
    origin: Triple,
    baseline: BaselineVoxelView,
  ): PaintedVolumeChunkVoxels {
    return {
      origin,
      size: this.chunkSize,
      baseline,
      patch: this.options.store.source.chunks.get(key),
    };
  }

  /** `undefined` for a chunk outside the texture. */
  private chunkTexelBoxOf(origin: Triple): TexelBox | undefined {
    return chunkBoxToTexelBox(
      this.extent,
      origin,
      wholeChunkBox(this.chunkSize),
    );
  }
}

/** Selection changes: visible segments and equivalences, temporary or not. */
function watchSegmentSelection(
  context: RefCounted,
  displayState: SegmentationDisplayState,
  callback: () => void,
): void {
  // `registerNestedSync` runs its body at once; only a later swap of the
  // group is a change.
  let isInitialRun = true;
  context.registerDisposer(
    registerNestedSync((nested, groupState) => {
      onVisibleSegmentsStateChanged(nested, groupState, callback);
      onTemporaryVisibleSegmentsStateChanged(nested, groupState, callback);
      if (!isInitialRun) callback();
      isInitialRun = false;
    }, displayState.segmentationGroupState),
  );
}
