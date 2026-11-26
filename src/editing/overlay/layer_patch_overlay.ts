/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file The edit overlay of one segmentation layer across its pyramid levels
 * (TM-524).
 *
 * Unsaved edits arrive per session resolution (`PatchMirror` routes each
 * library chunk by its resolution) and are stored one `LocalPatchStore` per
 * resolution: the stored levels. The segmentation render layer asks for the
 * provider of each level it draws:
 * - a level whose resolution holds the only edits gets that store's textures
 *   as they are (the common case: one session resolution, drawn as is);
 * - any other level gets a derived level: the edits of every edited
 *   resolution resampled to its grid (`patch_resampling.ts`), its own
 *   resolution first, then the closest.
 *
 * Derived levels are rebuilt lazily, only for the chunk boxes a change
 * touched, when a chunk is drawn, within a per-frame time budget; a derived
 * level not drawn for many drawn frames is freed. Stored levels without an
 * edited voxel never take part, so an empty store (created when a resolution
 * is merely read) does not hide another resolution's edits.
 */

import type { Resolution } from "@zettaai/edit-session";

import type {
  ChunkVoxelBox,
  LocalPatchChunk,
} from "#src/editing/local_patch_chunk.js";
import {
  chunkVoxelIndex,
  intersectionOfBoxes,
  unionOfBoxes,
} from "#src/editing/local_patch_chunk.js";
import type { ChunkKey } from "#src/editing/local_patch_source.js";
import {
  chunkGridKey,
  gridOfChunkKey,
} from "#src/editing/local_patch_source.js";
import { LocalPatchStore } from "#src/editing/local_patch_store.js";
import type { LevelResolutions } from "#src/editing/overlay/level_resolutions.js";
import type {
  LevelGeometry,
  ResampleSource,
  VoxelRange,
} from "#src/editing/overlay/patch_resampling.js";
import {
  chunkBoxesOfRange,
  chunkBoxInRange,
  chunkCountOfRange,
  levelGeometryOf,
  resamplePatchBox,
  sameLevel,
  sameChunkGrid,
  sameVoxelGrid,
  storedVoxelsPerTargetVoxel,
  targetRangeForStoredChange,
  withChunkDataSize,
} from "#src/editing/overlay/patch_resampling.js";
import type {
  PatchOverlayLevelSource,
  PyramidPatchOverlay,
} from "#src/editing/overlay/pyramid_patch_overlay.js";
import { PatchTextureCache } from "#src/editing/patch_texture_cache.js";
import type { PatchedMaskProvider } from "#src/editing/shaders/patched_mask_provider.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";

/** Edits stored at one session resolution. */
interface StoredLevel {
  readonly resolution: Resolution;
  readonly store: LocalPatchStore;
  readonly cache: PatchTextureCache;
  /** Keys of its chunks holding at least one edited voxel. */
  readonly editedChunks: Set<ChunkKey>;
}

function boxVoxels(box: ChunkVoxelBox): number {
  return (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) * (box.z1 - box.z0 + 1);
}

/** Whether `chunk` has an edited voxel inside `box` (or anywhere when null). */
function hasEditIn(chunk: LocalPatchChunk, box: ChunkVoxelBox | null): boolean {
  if (box === null) return chunk.patched.indexOf(1) !== -1;
  for (let z = box.z0; z <= box.z1; ++z) {
    for (let y = box.y0; y <= box.y1; ++y) {
      const rowStart = chunkVoxelIndex(chunk.chunkDataSize, 0, y, z);
      const row = chunk.patched.subarray(
        rowStart + box.x0,
        rowStart + box.x1 + 1,
      );
      if (row.indexOf(1) !== -1) return true;
    }
  }
  return false;
}

/** A stored level placed in model space, ready to resample from. */
interface PlacedLevel {
  readonly level: StoredLevel;
  readonly geometry: LevelGeometry;
}

/**
 * Counts the frames the layer is drawn in, from the viewer's frame number.
 * Neuroglancer only draws when something changes, so idleness is measured in
 * drawn frames, never in time: a still picture keeps every level it shows.
 */
class DrawnFrames {
  frame = 0;
  private lastFrameNumber: number | undefined;

  /** A chunk is being drawn in the viewer's frame `frameNumber`. */
  noteDraw(frameNumber: number) {
    if (frameNumber === this.lastFrameNumber) return;
    this.lastFrameNumber = frameNumber;
    ++this.frame;
  }
}

/**
 * Rebuild time per drawn frame, shared by an overlay's derived levels: a
 * level shown for the first time, a fill or an undo over a large chunk is
 * spread over several frames instead of stalling one. The window opens once
 * per drawn frame, so a step longer than a frame still ends that frame's
 * rebuilding.
 */
export class RebuildBudget {
  private frame = -1;
  private frameStart = 0;
  constructor(
    private readonly frames: DrawnFrames,
    private readonly budgetMs = 6,
  ) {}

  /** Whether this drawn frame may still rebuild. */
  hasTime(): boolean {
    const now = performance.now();
    if (this.frames.frame !== this.frame) {
      this.frame = this.frames.frame;
      this.frameStart = now;
    }
    return now - this.frameStart < this.budgetMs;
  }
}

/** Stored voxels read in one rebuild step, so a step fits well inside a frame. */
const STEP_STORED_VOXELS = 1 << 18;

/** Most boxes a chunk queues before they merge into their union. */
const MAX_QUEUED_BOXES = 32;

/**
 * The first step of `box` (at most `maxVoxels` target voxels: rows of its
 * first z slice, or part of one row) and what is left of it.
 */
export function splitIntoStep(
  box: ChunkVoxelBox,
  maxVoxels: number,
): { step: ChunkVoxelBox; rest: ChunkVoxelBox[] } {
  const width = box.x1 - box.x0 + 1;
  const rest: ChunkVoxelBox[] = [];
  if (box.z1 > box.z0) rest.push({ ...box, z0: box.z0 + 1 });
  if (width > maxVoxels) {
    const lastColumn = box.x0 + maxVoxels - 1;
    if (box.y1 > box.y0) rest.push({ ...box, z1: box.z0, y0: box.y0 + 1 });
    rest.push({ ...box, z1: box.z0, y1: box.y0, x0: lastColumn + 1 });
    return {
      step: { ...box, z1: box.z0, y1: box.y0, x1: lastColumn },
      rest,
    };
  }
  const rows = Math.max(1, Math.floor(maxVoxels / width));
  const lastRow = Math.min(box.y1, box.y0 + rows - 1);
  if (lastRow < box.y1) rest.push({ ...box, z1: box.z0, y0: lastRow + 1 });
  return { step: { ...box, z1: box.z0, y1: lastRow }, rest };
}

/** Stale boxes of one derived chunk, worked off within the frame budget. */
interface StaleChunk {
  readonly gridPosition: readonly [number, number, number];
  boxes: ChunkVoxelBox[];
  /**
   * The boxes only need rebuilding where this level already shows edits (a
   * stored chunk was dropped: nothing new can appear there).
   */
  onlyShown: boolean;
  /** This rebuild made the chunk: dropped again if it shows nothing. */
  created: boolean;
  /** This rebuild found an edit. */
  patched: boolean;
}

/**
 * A change too large to split into chunk boxes up front (e.g. a big fill seen
 * on a much coarser level, or the first show of a level over many chunks):
 * applied to a chunk only when that chunk is drawn or read.
 */
interface StaleRange {
  readonly range: VoxelRange;
  readonly onlyShown: boolean;
  /** Chunks it was already applied to. */
  readonly appliedTo: Set<ChunkKey>;
}

/** Above this many target chunks, a change is kept as a `StaleRange`. */
const MAX_CHUNKS_PER_CHANGE = 256;

/** Above this many stale ranges, they merge into their union. */
const MAX_STALE_RANGES = 8;

/** Edits of the stored levels, resampled to another level's grid. */
class DerivedLevel extends RefCounted implements PatchedMaskProvider {
  private readonly store = new LocalPatchStore();
  private readonly cache: PatchTextureCache;
  private readonly sources: ResampleSource[];
  /** Target voxels per rebuild step (bounded by the stored voxels read). */
  private readonly stepVoxels: number;
  private readonly staleChunks = new Map<ChunkKey, StaleChunk>();
  private staleRanges: StaleRange[] = [];
  /**
   * A chunk could not be allocated (out of memory): the level shows no
   * edits rather than failing every frame.
   */
  private unusable = false;
  /** The drawn frame this level was last drawn or read in. */
  lastUsedFrame: number;

  /**
   * @param placed The stored levels with edits, in priority order.
   * @param budget Rebuild time shared by the overlay's levels per frame.
   * @param changed The overlay's redraw signal: also asked to finish a
   *     rebuild on the next frame.
   */
  constructor(
    readonly target: LevelGeometry,
    placed: readonly PlacedLevel[],
    private readonly budget: RebuildBudget,
    private readonly frames: DrawnFrames,
    readonly changed: NullarySignal,
  ) {
    super();
    this.lastUsedFrame = frames.frame;
    this.registerDisposer(this.store);
    this.cache = this.registerDisposer(new PatchTextureCache(this.store));
    this.sources = placed.map(({ level, geometry }) => ({
      geometry,
      chunkAt: (gridX, gridY, gridZ) =>
        level.store.source.getChunk([gridX, gridY, gridZ]),
    }));
    const costliest = Math.max(
      1,
      ...placed.map(({ geometry }) =>
        storedVoxelsPerTargetVoxel(geometry, target),
      ),
    );
    this.stepVoxels = Math.max(1, Math.floor(STEP_STORED_VOXELS / costliest));
    for (const { level, geometry } of placed) {
      this.registerDisposer(
        level.store.chunkChanged.add((change) => {
          // A store emptied is a change of the edited set: the overlay
          // replaces this level.
          if (change.kind === "chunk") {
            this.storedChunkChanged(level, geometry, change.key, change.box);
          }
        }),
      );
      for (const [key, chunk] of level.store.source.chunks) {
        if (chunk.paintedBounds === null) continue;
        this.markStale(
          geometry,
          gridOfChunkKey(key),
          chunk.paintedBounds,
          false,
        );
      }
    }
  }

  get is3D(): boolean {
    return this.cache.is3D;
  }

  get patchStrides(): Int32Array {
    return this.cache.patchStrides;
  }

  bindPatchedMaskTextures(
    gl: GL,
    unit2D: number,
    unit3D: number,
    chunkGridPosition: ArrayLike<number>,
  ): void {
    this.lastUsedFrame = this.frames.frame;
    this.rebuild(chunkGridPosition, false);
    this.cache.bindPatchedMaskTextures(gl, unit2D, unit3D, chunkGridPosition);
  }

  bindPatchValueTextures(
    gl: GL,
    unit2D: number,
    unit3D: number,
    chunkGridPosition: ArrayLike<number>,
  ): void {
    this.rebuild(chunkGridPosition, false);
    this.cache.bindPatchValueTextures(gl, unit2D, unit3D, chunkGridPosition);
  }

  getPatchedValueAt(
    chunkGridPosition: ArrayLike<number>,
    localOffset: readonly [number, number, number],
  ): bigint | undefined {
    this.lastUsedFrame = this.frames.frame;
    // A value read (hover, picking) must be exact, but only for its voxel:
    // the rest of a stale chunk stays within the frame budget.
    this.rebuildVoxel(chunkGridPosition, localOffset);
    return this.cache.getPatchedValueAt(chunkGridPosition, localOffset);
  }

  disposed() {
    // Freed on purpose: drop the chunk arrays now, whoever still holds this.
    this.staleChunks.clear();
    this.staleRanges = [];
    this.store.source.clearAll();
    super.disposed();
  }

  /** Every chunk this level shows, rebuilt where stale (tests, diagnostics). */
  shownChunks(): Iterable<[ChunkKey, LocalPatchChunk]> {
    for (const { range } of this.staleRanges) {
      for (const { gridPosition } of chunkBoxesOfRange(
        range,
        this.target.chunkDataSize,
      )) {
        this.rebuild(gridPosition, true);
      }
    }
    // A snapshot: each rebuild removes its chunk's entry.
    for (const { gridPosition } of Array.from(this.staleChunks.values())) {
      this.rebuild(gridPosition, true);
    }
    return this.store.source.chunks;
  }

  /**
   * A stored chunk changed. A change without a box (undo, redo, a commit
   * replay) is bounded by the chunk's painted bounds, which only grow and so
   * hold every voxel it ever edited; a dropped chunk can only remove edits.
   */
  private storedChunkChanged(
    level: StoredLevel,
    geometry: LevelGeometry,
    key: ChunkKey,
    box: ChunkVoxelBox | null,
  ) {
    const grid = gridOfChunkKey(key);
    if (box !== null) {
      this.markStale(geometry, grid, box, false);
      return;
    }
    const chunk = level.store.source.chunks.get(key);
    if (chunk === undefined) {
      this.markStale(geometry, grid, null, true);
    } else if (chunk.paintedBounds !== null) {
      this.markStale(geometry, grid, chunk.paintedBounds, false);
    }
  }

  private markStale(
    storedGeometry: LevelGeometry,
    storedGrid: ArrayLike<number>,
    storedBox: ChunkVoxelBox | null,
    onlyShown: boolean,
  ) {
    const range = targetRangeForStoredChange(
      storedGeometry,
      storedGrid,
      storedBox,
      this.target,
    );
    if (range === null) return;
    if (
      chunkCountOfRange(range, this.target.chunkDataSize) >
      MAX_CHUNKS_PER_CHANGE
    ) {
      this.addStaleRange(range, onlyShown);
      return;
    }
    for (const { gridPosition, box } of chunkBoxesOfRange(
      range,
      this.target.chunkDataSize,
    )) {
      this.addStaleBox(gridPosition, box, onlyShown);
    }
  }

  private addStaleRange(range: VoxelRange, onlyShown: boolean) {
    this.staleRanges.push({ range, onlyShown, appliedTo: new Set() });
    if (this.staleRanges.length <= MAX_STALE_RANGES) return;
    // Their union, applied afresh: still every stale voxel, in one range.
    const lowest: [number, number, number] = [Infinity, Infinity, Infinity];
    const highest: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const stale of this.staleRanges) {
      for (let axis = 0; axis < 3; ++axis) {
        lowest[axis] = Math.min(lowest[axis], stale.range.lowest[axis]);
        highest[axis] = Math.max(highest[axis], stale.range.highest[axis]);
      }
    }
    this.staleRanges = [
      {
        range: { lowest, highest },
        onlyShown: this.staleRanges.every((stale) => stale.onlyShown),
        appliedTo: new Set(),
      },
    ];
  }

  private addStaleBox(
    gridPosition: readonly [number, number, number],
    box: ChunkVoxelBox,
    onlyShown: boolean,
  ) {
    const key = chunkGridKey(gridPosition);
    const existing = this.staleChunks.get(key);
    if (existing === undefined) {
      this.staleChunks.set(key, {
        gridPosition,
        boxes: [box],
        onlyShown,
        created: false,
        patched: false,
      });
      return;
    }
    existing.onlyShown &&= onlyShown;
    existing.boxes.push(box);
    if (existing.boxes.length > MAX_QUEUED_BOXES) {
      // Still a superset of every stale voxel, rebuilt as one box.
      existing.boxes = [unionOfBoxes(existing.boxes)];
    }
  }

  /** The stale chunk at `gridPosition`, with any stale range applied to it. */
  private staleChunkAt(
    gridPosition: ArrayLike<number>,
  ): StaleChunk | undefined {
    const key = chunkGridKey(gridPosition);
    for (const stale of this.staleRanges) {
      if (stale.appliedTo.has(key)) continue;
      stale.appliedTo.add(key);
      const box = chunkBoxInRange(
        stale.range,
        gridPosition,
        this.target.chunkDataSize,
      );
      if (box === null) continue;
      this.addStaleBox(
        [gridPosition[0], gridPosition[1], gridPosition[2]],
        box,
        stale.onlyShown,
      );
    }
    return this.staleChunks.get(key);
  }

  /**
   * The chunk at `gridPosition`, created full-size when missing: every chunk
   * of a level shares one texture layout in the cache, and the shader maps a
   * voxel of neuroglancer's (possibly edge-clipped) chunk into it by its
   * chunk-local position, which a full-size texture always covers.
   * `undefined` when it cannot be allocated; the level then shows nothing.
   */
  private chunkFor(stale: StaleChunk): LocalPatchChunk | undefined {
    const key = chunkGridKey(stale.gridPosition);
    const existing = this.store.source.chunks.get(key);
    if (existing !== undefined) return existing;
    try {
      const chunk = this.store.source.getOrCreateChunk(
        stale.gridPosition,
        this.target.chunkDataSize,
      );
      stale.created = true;
      return chunk;
    } catch {
      this.giveUp();
      return undefined;
    }
  }

  /** Out of memory for this level: show no edits, never retry per frame. */
  private giveUp() {
    this.unusable = true;
    this.staleChunks.clear();
    this.staleRanges = [];
    this.store.source.clearAll();
  }

  /** Bring one voxel up to date when a stale box of its chunk holds it. */
  private rebuildVoxel(
    chunkGridPosition: ArrayLike<number>,
    [x, y, z]: readonly [number, number, number],
  ) {
    if (this.unusable) return;
    const stale = this.staleChunkAt(chunkGridPosition);
    if (stale === undefined) return;
    const holds = stale.boxes.some(
      (box) =>
        x >= box.x0 &&
        x <= box.x1 &&
        y >= box.y0 &&
        y <= box.y1 &&
        z >= box.z0 &&
        z <= box.z1,
    );
    if (!holds) return;
    const createdBefore = stale.created;
    const chunk = this.chunkFor(stale);
    if (chunk === undefined) return;
    const voxel = { x0: x, y0: y, z0: z, x1: x, y1: y, z1: z };
    if (
      resamplePatchBox(
        this.sources,
        this.target,
        stale.gridPosition,
        chunk,
        voxel,
      )
    ) {
      chunk.growPaintedBounds(voxel);
      stale.patched = true;
    } else if (stale.created && !createdBefore) {
      // Made only for this read, and nothing to show: not kept.
      this.store.source.clearChunk(chunkGridKey(stale.gridPosition));
      stale.created = false;
    }
    // The stale box still covers the voxel: the chunk's rebuild finishes it
    // (and uploads it).
  }

  /**
   * Work off the stale boxes of the chunk at `chunkGridPosition`, a step at a
   * time while the frame budget lasts (all of them when `force`). What is
   * left is rebuilt on the next frames, which this asks for.
   */
  private rebuild(chunkGridPosition: ArrayLike<number>, force: boolean) {
    if (this.unusable) return;
    const stale = this.staleChunkAt(chunkGridPosition);
    if (stale === undefined) return;
    for (
      let box = stale.boxes.pop();
      box !== undefined;
      box = stale.boxes.pop()
    ) {
      if (!force && !this.budget.hasTime()) {
        stale.boxes.push(box);
        this.changed.dispatch();
        return;
      }
      if (!this.rebuildStep(stale, box)) return;
    }
    const key = chunkGridKey(stale.gridPosition);
    this.staleChunks.delete(key);
    if (stale.created && !stale.patched) {
      // Nothing to show: no chunk (and no textures) for it.
      this.store.source.clearChunk(key);
    }
  }

  /**
   * Rebuild one step of `box` in `stale`'s chunk, queueing the rest. Returns
   * false when the chunk cannot be allocated.
   */
  private rebuildStep(stale: StaleChunk, box: ChunkVoxelBox): boolean {
    let todo: ChunkVoxelBox | null = box;
    if (stale.onlyShown) {
      // Only edits can disappear: nothing to do where none are shown.
      const shownBounds = this.store.source.chunks.get(
        chunkGridKey(stale.gridPosition),
      )?.paintedBounds;
      todo =
        shownBounds == null ? null : intersectionOfBoxes(todo, shownBounds);
      if (todo === null) return true;
    }
    const { step, rest } = splitIntoStep(todo, this.stepVoxels);
    stale.boxes.push(...rest);
    const chunk = this.chunkFor(stale);
    if (chunk === undefined) return false;
    const anyPatched = resamplePatchBox(
      this.sources,
      this.target,
      stale.gridPosition,
      chunk,
      step,
    );
    // Uploaded on the bind that follows; no store signal, which would only
    // schedule another redraw of what is being drawn now.
    if (anyPatched) {
      chunk.growPaintedBounds(step);
      stale.patched = true;
    }
    chunk.dirty = true;
    chunk.mergePendingUpload(step);
    return true;
  }
}

/**
 * Drawn frames without drawing or reading a derived level after which it is
 * freed (CPU and GPU memory).
 */
export const DERIVED_LEVEL_IDLE_FRAMES = 120;

/**
 * Largest voxel size ratio, per axis, between a stored level and a level it
 * is resampled to: beyond it a level shows no resampled edits, so a broken
 * or extreme transform cannot make one voxel read millions.
 */
export const MAX_LEVEL_RATIO = 64;

/** A provider with no patches: every chunk binds the zero fallbacks. */
class EmptyLevel extends RefCounted {
  readonly cache: PatchTextureCache;
  constructor() {
    super();
    const store = this.registerDisposer(new LocalPatchStore());
    this.cache = this.registerDisposer(new PatchTextureCache(store));
  }
}

/** A level the layer can draw, as listed by its render layer. */
interface KnownLevel {
  readonly resolution: Resolution;
  /** `undefined` for a rotated, flipped or broken level (not resampled). */
  readonly geometry: LevelGeometry | undefined;
}

export class LayerPatchOverlay
  extends RefCounted
  implements PyramidPatchOverlay
{
  readonly changed = new NullarySignal();
  private readonly storedLevels = new Map<Resolution, StoredLevel>();
  /** Stored levels holding at least one edited voxel. */
  private readonly editedLevels = new Set<StoredLevel>();
  /** Keyed by the resolution and geometry of the level drawn. */
  private readonly derivedLevels = new Map<string, DerivedLevel>();
  /** Geometry of every level seen, by resolution. */
  private readonly geometryByResolution = new Map<
    Resolution,
    LevelGeometry[]
  >();
  /** The level of each chunk source listed by the render layer. */
  private readonly levelOfChunkSource = new WeakMap<object, KnownLevel>();
  private readonly empty: EmptyLevel;
  /**
   * The provider found for each chunk source, valid while `generation` is
   * unchanged: `forChunkSource` runs for every drawn chunk on every frame.
   */
  private providerByChunkSource = new WeakMap<
    object,
    { generation: number; provider: PatchedMaskProvider }
  >();
  /** Bumped whenever a chunk source could map to a different provider. */
  private generation = 0;
  private readonly frames = new DrawnFrames();
  private lastIdleCheckFrame = 0;
  private readonly rebuildBudget = new RebuildBudget(this.frames);

  /** @param levels The session resolution of each level's source. */
  constructor(private readonly levels: LevelResolutions) {
    super();
    this.empty = this.registerDisposer(new EmptyLevel());
  }

  /** The store edits at `resolution` are mirrored into, created if needed. */
  storeFor(resolution: Resolution): LocalPatchStore {
    return this.storedLevel(resolution).store;
  }

  /** The store of `resolution` if it exists; never creates one. */
  existingStoreFor(resolution: Resolution): LocalPatchStore | undefined {
    return this.storedLevels.get(resolution)?.store;
  }

  /** The store of the first resolution holding edits, if any. */
  firstEditedStore(): LocalPatchStore | undefined {
    return this.editedLevels.values().next().value?.store;
  }

  /** Every store with its resolution. */
  storedStores(): Iterable<[Resolution, LocalPatchStore]> {
    return Array.from(this.storedLevels.values(), (level) => [
      level.resolution,
      level.store,
    ]);
  }

  observeLevels(sources: Iterable<PatchOverlayLevelSource>): void {
    let newGeometry = false;
    for (const source of sources) {
      const geometry = levelGeometryOf(source);
      let resolution: Resolution;
      try {
        resolution = this.levels.resolutionOf(source);
      } catch {
        // A level whose resolution cannot be named shows no edits.
        continue;
      }
      this.levelOfChunkSource.set(source.chunkSource, { resolution, geometry });
      if (geometry === undefined) continue;
      const known = this.geometryByResolution.get(resolution) ?? [];
      if (known.some((existing) => sameLevel(existing, geometry))) continue;
      known.push(geometry);
      this.geometryByResolution.set(resolution, known);
      newGeometry = true;
    }
    // A stored level may only now be placeable.
    if (newGeometry) this.editedSetChanged();
    else ++this.generation;
  }

  forChunkSource(
    chunkSource: object | undefined,
    drawnFrame: number | undefined,
  ): PatchedMaskProvider {
    if (drawnFrame !== undefined) {
      this.frames.noteDraw(drawnFrame);
      this.freeIdleDerivedLevels();
    }
    if (chunkSource === undefined) return this.empty.cache;
    const cached = this.providerByChunkSource.get(chunkSource);
    if (cached !== undefined && cached.generation === this.generation) {
      return cached.provider;
    }
    const known = this.levelOfChunkSource.get(chunkSource);
    const shown =
      known === undefined
        ? undefined
        : this.levelFor(known.resolution, known.geometry);
    const provider =
      shown === undefined
        ? this.empty.cache
        : shown instanceof DerivedLevel
          ? shown
          : shown.cache;
    this.providerByChunkSource.set(chunkSource, {
      generation: this.generation,
      provider,
    });
    return provider;
  }

  /**
   * The edited voxels the level of `resolution` shows, chunk by chunk, with
   * each chunk's first voxel in that level's coordinates. For tests and
   * diagnostics: what the overlay draws there, resampled levels included.
   */
  shownChunksAt(
    resolution: Resolution,
  ): { origin: [number, number, number]; chunk: LocalPatchChunk }[] {
    const geometry = this.geometryByResolution.get(resolution)?.[0];
    const shown = this.levelFor(resolution, geometry);
    let chunks: Iterable<[ChunkKey, LocalPatchChunk]>;
    let gridSize: readonly number[] | undefined;
    if (shown instanceof DerivedLevel) {
      chunks = shown.shownChunks();
      gridSize = shown.target.chunkDataSize;
    } else if (shown === undefined) {
      chunks = [];
    } else {
      chunks = shown.store.source.chunks;
    }
    return Array.from(chunks, ([key, chunk]) => {
      const grid = gridOfChunkKey(key);
      const size = gridSize ?? chunk.chunkDataSize;
      return {
        origin: [grid[0] * size[0], grid[1] * size[1], grid[2] * size[2]],
        chunk,
      };
    });
  }

  /**
   * What the level of `resolution` at `geometry` shows: a stored level as is,
   * a derived level, or nothing.
   */
  private levelFor(
    resolution: Resolution,
    geometry: LevelGeometry | undefined,
  ): StoredLevel | DerivedLevel | undefined {
    const exact = this.storedLevels.get(resolution);
    // A rotated or flipped level is not resampled; its own resolution's
    // edits still show as they are.
    if (geometry === undefined) return exact;
    if (this.editedLevels.size === 0) return exact;
    if (this.holdsTheOnlyEditsAsDrawn(exact, geometry)) return exact;
    return (
      this.derivedFor(resolution, geometry, exact) ??
      this.unresampledFallback(exact)
    );
  }

  /**
   * `exact` holds the only edits, on the drawn level's voxel and chunk grid:
   * its store is shown as is (the usual one-resolution session).
   */
  private holdsTheOnlyEditsAsDrawn(
    exact: StoredLevel | undefined,
    geometry: LevelGeometry,
  ): exact is StoredLevel {
    if (
      exact === undefined ||
      this.editedLevels.size !== 1 ||
      !this.editedLevels.has(exact)
    ) {
      return false;
    }
    const placed = this.placed(exact);
    return (
      placed === undefined ||
      (sameVoxelGrid(placed.geometry, geometry) &&
        sameChunkGrid(placed.geometry, geometry))
    );
  }

  /**
   * When no derived level applies. Edits that can be placed but not on this
   * level (too far in voxel size) are not shown: unresampled, they would be
   * misplaced. When no edited level can be placed at all (e.g. a level's
   * resolution does not name the session's), the store of the drawn
   * resolution, or the only edited one, is shown as is, as before TM-524,
   * rather than nothing.
   */
  private unresampledFallback(
    exact: StoredLevel | undefined,
  ): StoredLevel | undefined {
    for (const level of this.editedLevels) {
      if (this.placed(level) !== undefined) return undefined;
    }
    return (
      exact ??
      (this.editedLevels.size === 1
        ? this.editedLevels.values().next().value
        : undefined)
    );
  }

  private storedLevel(resolution: Resolution): StoredLevel {
    let level = this.storedLevels.get(resolution);
    if (level === undefined) {
      const store = this.registerDisposer(new LocalPatchStore());
      const cache = this.registerDisposer(new PatchTextureCache(store));
      const created: StoredLevel = {
        resolution,
        store,
        cache,
        editedChunks: new Set(),
      };
      this.registerDisposer(store.changed.add(this.changed.dispatch));
      this.registerDisposer(
        store.chunkChanged.add((change) => {
          if (change.kind === "all-cleared") {
            created.editedChunks.clear();
          } else {
            this.noteChunkEdits(created, change.key, change.box);
          }
          this.noteEdited(created);
        }),
      );
      this.storedLevels.set(resolution, created);
      level = created;
    }
    return level;
  }

  /**
   * Whether the stored chunk at `key` still holds an edited voxel: a change
   * with an edit in its box keeps it edited cheaply; otherwise the chunk is
   * scanned.
   */
  private noteChunkEdits(
    level: StoredLevel,
    key: ChunkKey,
    box: ChunkVoxelBox | null,
  ) {
    const chunk = level.store.source.chunks.get(key);
    const edited =
      chunk !== undefined &&
      ((box !== null && boxVoxels(box) > 0 && hasEditIn(chunk, box)) ||
        hasEditIn(chunk, null));
    if (edited) level.editedChunks.add(key);
    else level.editedChunks.delete(key);
  }

  /** Track whether `level` holds edits; the edited set decides the providers. */
  private noteEdited(level: StoredLevel) {
    const edited = level.editedChunks.size > 0;
    if (edited === this.editedLevels.has(level)) return;
    if (edited) this.editedLevels.add(level);
    else this.editedLevels.delete(level);
    this.editedSetChanged();
  }

  /** On a new drawn frame: free derived levels not used for many frames. */
  private freeIdleDerivedLevels() {
    const { frame } = this.frames;
    if (frame === this.lastIdleCheckFrame) return;
    this.lastIdleCheckFrame = frame;
    let freed = false;
    for (const [key, derived] of this.derivedLevels) {
      if (frame - derived.lastUsedFrame <= DERIVED_LEVEL_IDLE_FRAMES) continue;
      derived.dispose();
      this.derivedLevels.delete(key);
      freed = true;
    }
    if (freed) this.forgetProviders();
  }

  /** Chunk sources may map to a freed level: drop every cached provider. */
  private forgetProviders() {
    ++this.generation;
    this.providerByChunkSource = new WeakMap();
  }

  private editedSetChanged() {
    this.forgetProviders();
    for (const derived of this.derivedLevels.values()) derived.dispose();
    this.derivedLevels.clear();
  }

  /**
   * A stored level placed in model space: a seen level of its resolution,
   * with the session's own chunk grid (the size of its stored chunks, which
   * can be clipped to the volume where neuroglancer's chunks are not).
   */
  private placed(level: StoredLevel): PlacedLevel | undefined {
    const known = this.geometryByResolution.get(level.resolution);
    if (known === undefined) return undefined;
    const firstChunk = level.store.source.chunks.values().next().value;
    const geometry =
      firstChunk === undefined
        ? known[0]
        : withChunkDataSize(known[0], firstChunk.chunkDataSize);
    return { level, geometry };
  }

  /**
   * The derived level for `geometry`: every edited stored level that can be
   * placed within `MAX_LEVEL_RATIO`, its own resolution first, then by
   * closeness in voxel size; `undefined` when none qualifies.
   */
  private derivedFor(
    resolution: Resolution,
    geometry: LevelGeometry,
    exact: StoredLevel | undefined,
  ): DerivedLevel | undefined {
    // The whole geometry: two data sources of one resolution can differ in
    // offset or bounds.
    const key = `${resolution}|${JSON.stringify(geometry)}`;
    const existing = this.derivedLevels.get(key);
    if (existing !== undefined) return existing;
    const distance = (placed: PlacedLevel) => {
      if (placed.level === exact) return -1;
      let total = 0;
      for (let axis = 0; axis < 3; ++axis) {
        total += Math.abs(
          Math.log(
            geometry.axes[axis].scale / placed.geometry.axes[axis].scale,
          ),
        );
      }
      return total;
    };
    const withinRatio = (entry: PlacedLevel) =>
      entry.geometry.axes.every((axis, index) => {
        const ratio = geometry.axes[index].scale / axis.scale;
        return ratio <= MAX_LEVEL_RATIO && ratio >= 1 / MAX_LEVEL_RATIO;
      });
    const placed = Array.from(this.editedLevels, (level) => this.placed(level))
      .filter(
        (entry): entry is PlacedLevel =>
          entry !== undefined && withinRatio(entry),
      )
      .sort((first, second) => distance(first) - distance(second));
    if (placed.length === 0) return undefined;
    const derived = new DerivedLevel(
      geometry,
      placed,
      this.rebuildBudget,
      this.frames,
      this.changed,
    );
    this.derivedLevels.set(key, derived);
    return derived;
  }

  disposed() {
    for (const derived of this.derivedLevels.values()) derived.dispose();
    this.derivedLevels.clear();
    super.disposed();
  }
}
