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
 * @file Resampling of unsaved edits between pyramid levels (TM-524).
 *
 * Edits are stored at the session's resolutions. A level drawn at another
 * resolution shows them resampled to its own voxel grid, the way the save
 * path resamples the stored data:
 * - coarser level: a voxel shows the edit value when at least half of the
 *   finer voxels it covers carry that value (mode downsampling, as tinybrain
 *   does for segmentation; ties on a stroke's edge can differ by one voxel);
 * - finer level: a voxel shows the edit of the coarser voxel containing it
 *   (nearest upsampling).
 *
 * With edits at several session resolutions, a level takes each voxel from
 * the first source (in the caller's priority order) that has an edit there.
 */

import type {
  ChunkVoxelBox,
  LocalPatchChunk,
} from "#src/editing/local_patch_chunk.js";
import type { PatchOverlayLevelSource } from "#src/editing/overlay/pyramid_patch_overlay.js";

type Triple = readonly [number, number, number];

/** Model (multiscale) coordinate of a level's voxel `v` along one axis: `scale * v + offset`. */
export interface AxisMapping {
  readonly scale: number;
  readonly offset: number;
}

/**
 * Where one pyramid level's voxels lie in model space, how its chunk grid is
 * laid out, and where its volume ends (edge chunks are clipped there).
 */
export interface LevelGeometry {
  readonly axes: readonly [AxisMapping, AxisMapping, AxisMapping];
  /** Chunk grid stride: the size of a full chunk. */
  readonly chunkDataSize: Triple;
  /** Inclusive lower voxel bound (may be negative); 0 when unknown. */
  readonly lowerVoxelBound: Triple;
  /** Exclusive upper voxel bound; `Infinity` when unknown. */
  readonly upperVoxelBound: Triple;
}

/**
 * Largest chunk a level may have to be resampled: a derived chunk is held as
 * a full chunk in memory (9 bytes a voxel, plus its textures), so 2^24 voxels
 * (a 4096² slice) is about 150 MB; larger chunks are not resampled.
 */
const MAX_CHUNK_VOXELS = 1 << 24;

/** Entry (`row`, `column`) of a column-major `(rank + 1)²` affine transform. */
function transformEntry(
  transform: Float32Array,
  rank: number,
  row: number,
  column: number,
): number {
  return transform[column * (rank + 1) + row];
}

/**
 * Geometry of `source` along its first three axes, or `undefined` when its
 * voxels are not axis-aligned with positive, finite scales in model space
 * (rotated, sheared, flipped or broken levels are not resampled).
 */
export function levelGeometryOf(
  source: PatchOverlayLevelSource,
): LevelGeometry | undefined {
  const { rank, chunkDataSize, lowerVoxelBound, upperVoxelBound } =
    source.chunkSource.spec;
  if (rank < 3 || chunkDataSize.length < 3) return undefined;
  const chunkVoxels = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
  if (!(chunkVoxels > 0 && chunkVoxels <= MAX_CHUNK_VOXELS)) return undefined;
  const transform = source.chunkToMultiscaleTransform;
  const axisMapping = (row: number): AxisMapping | undefined => {
    for (let column = 0; column < 3; ++column) {
      if (
        column !== row &&
        transformEntry(transform, rank, row, column) !== 0
      ) {
        return undefined;
      }
    }
    const scale = transformEntry(transform, rank, row, row);
    const offset = transformEntry(transform, rank, row, rank);
    if (!(scale > 0) || !Number.isFinite(scale) || !Number.isFinite(offset)) {
      return undefined;
    }
    return { scale, offset };
  };
  const axisX = axisMapping(0);
  const axisY = axisMapping(1);
  const axisZ = axisMapping(2);
  if (axisX === undefined || axisY === undefined || axisZ === undefined) {
    return undefined;
  }
  const lower = (axis: number) =>
    lowerVoxelBound === undefined ? 0 : lowerVoxelBound[axis];
  const upper = (axis: number) =>
    upperVoxelBound === undefined ? Infinity : upperVoxelBound[axis];
  return {
    axes: [axisX, axisY, axisZ],
    chunkDataSize: [chunkDataSize[0], chunkDataSize[1], chunkDataSize[2]],
    lowerVoxelBound: [lower(0), lower(1), lower(2)],
    upperVoxelBound: [upper(0), upper(1), upper(2)],
  };
}

/** `geometry` with another chunk grid (the session's own chunking). */
export function withChunkDataSize(
  geometry: LevelGeometry,
  chunkDataSize: ArrayLike<number>,
): LevelGeometry {
  return {
    ...geometry,
    chunkDataSize: [chunkDataSize[0], chunkDataSize[1], chunkDataSize[2]],
  };
}

/** Same voxels in model space (chunking aside). */
export function sameVoxelGrid(
  first: LevelGeometry,
  second: LevelGeometry,
): boolean {
  for (let axis = 0; axis < 3; ++axis) {
    if (
      Math.abs(first.axes[axis].scale - second.axes[axis].scale) > 1e-9 ||
      Math.abs(first.axes[axis].offset - second.axes[axis].offset) > 1e-9
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Same chunk grid: equal chunk sizes, or, along an axis whose whole volume
 * fits in one chunk, any chunk at least that large (the session clips such a
 * chunk to the volume, TM-373; neuroglancer keeps the nominal size).
 */
export function sameChunkGrid(
  first: LevelGeometry,
  second: LevelGeometry,
): boolean {
  for (let axis = 0; axis < 3; ++axis) {
    const firstSize = first.chunkDataSize[axis];
    const secondSize = second.chunkDataSize[axis];
    if (firstSize === secondSize) continue;
    const extent = second.upperVoxelBound[axis] - second.lowerVoxelBound[axis];
    if (
      !Number.isFinite(extent) ||
      second.lowerVoxelBound[axis] !== 0 ||
      firstSize < extent ||
      secondSize < extent
    ) {
      return false;
    }
  }
  return true;
}

/** Same voxel grid and chunking. */
export function sameLevel(
  first: LevelGeometry,
  second: LevelGeometry,
): boolean {
  return (
    sameVoxelGrid(first, second) &&
    first.chunkDataSize.every(
      (extent, axis) => extent === second.chunkDataSize[axis],
    )
  );
}

/** A chunk of a level and a box (chunk-local, inclusive) inside it. */
export interface ChunkBox {
  readonly gridPosition: Triple;
  readonly box: ChunkVoxelBox;
}

// Snap model→voxel divisions that land on a voxel boundary up to float noise.
const EPSILON = 1e-6;

function boxLow(box: ChunkVoxelBox, axis: number): number {
  return axis === 0 ? box.x0 : axis === 1 ? box.y0 : box.z0;
}

function boxHigh(box: ChunkVoxelBox, axis: number): number {
  return axis === 0 ? box.x1 : axis === 1 ? box.y1 : box.z1;
}

/** A range of a level's voxels: absolute, inclusive. */
export interface VoxelRange {
  readonly lowest: Triple;
  readonly highest: Triple;
}

/**
 * The target voxels whose resampled values can depend on the stored voxels
 * `storedBox` of the stored chunk at `storedGrid` (`null` box = the whole
 * chunk), within the target level's volume; `null` when there are none.
 */
export function targetRangeForStoredChange(
  stored: LevelGeometry,
  storedGrid: ArrayLike<number>,
  storedBox: ChunkVoxelBox | null,
  target: LevelGeometry,
): VoxelRange | null {
  const bounds = (axis: number): [number, number] => {
    const size = stored.chunkDataSize[axis];
    const chunkStart = storedGrid[axis] * size;
    const low = storedBox === null ? 0 : boxLow(storedBox, axis);
    const high = storedBox === null ? size - 1 : boxHigh(storedBox, axis);
    const { scale, offset } = stored.axes[axis];
    const modelLow = scale * (chunkStart + low) + offset;
    const modelHigh = scale * (chunkStart + high + 1) + offset;
    const targetAxis = target.axes[axis];
    return [
      Math.max(
        target.lowerVoxelBound[axis],
        Math.floor((modelLow - targetAxis.offset) / targetAxis.scale + EPSILON),
      ),
      Math.min(
        target.upperVoxelBound[axis] - 1,
        Math.ceil(
          (modelHigh - targetAxis.offset) / targetAxis.scale - EPSILON,
        ) - 1,
      ),
    ];
  };
  const [lowX, highX] = bounds(0);
  const [lowY, highY] = bounds(1);
  const [lowZ, highZ] = bounds(2);
  if (highX < lowX || highY < lowY || highZ < lowZ) return null;
  return { lowest: [lowX, lowY, lowZ], highest: [highX, highY, highZ] };
}

/** Chunks of `chunkDataSize` that `range` touches. */
export function chunkCountOfRange(
  range: VoxelRange,
  chunkDataSize: Triple,
): number {
  let count = 1;
  for (let axis = 0; axis < 3; ++axis) {
    const size = chunkDataSize[axis];
    count *=
      Math.floor(range.highest[axis] / size) -
      Math.floor(range.lowest[axis] / size) +
      1;
  }
  return count;
}

/** The part of `range` inside the chunk at `gridPosition`, chunk-local; or `null`. */
export function chunkBoxInRange(
  range: VoxelRange,
  gridPosition: ArrayLike<number>,
  chunkDataSize: Triple,
): ChunkVoxelBox | null {
  const along = (axis: number): [number, number] => {
    const chunkStart = gridPosition[axis] * chunkDataSize[axis];
    return [
      Math.max(range.lowest[axis], chunkStart) - chunkStart,
      Math.min(range.highest[axis], chunkStart + chunkDataSize[axis] - 1) -
        chunkStart,
    ];
  };
  const [x0, x1] = along(0);
  const [y0, y1] = along(1);
  const [z0, z1] = along(2);
  if (x1 < x0 || y1 < y0 || z1 < z0) return null;
  return { x0, y0, z0, x1, y1, z1 };
}

/** `range` split into per-chunk boxes (see `chunkCountOfRange` for how many). */
export function chunkBoxesOfRange(
  range: VoxelRange,
  chunkDataSize: Triple,
): ChunkBox[] {
  const gridsAlong = (axis: number) => {
    const grids: number[] = [];
    const size = chunkDataSize[axis];
    for (
      let grid = Math.floor(range.lowest[axis] / size);
      grid * size <= range.highest[axis];
      ++grid
    ) {
      grids.push(grid);
    }
    return grids;
  };
  const result: ChunkBox[] = [];
  for (const gridZ of gridsAlong(2)) {
    for (const gridY of gridsAlong(1)) {
      for (const gridX of gridsAlong(0)) {
        const gridPosition: Triple = [gridX, gridY, gridZ];
        const box = chunkBoxInRange(range, gridPosition, chunkDataSize);
        if (box !== null) result.push({ gridPosition, box });
      }
    }
  }
  return result;
}

/**
 * The boxes of `target`'s chunks whose resampled values can depend on the
 * stored voxels `storedBox` of the stored chunk at `storedGrid` (`null` box =
 * the whole chunk). Boxes stay within the target level's volume.
 */
export function targetBoxesForStoredChange(
  stored: LevelGeometry,
  storedGrid: ArrayLike<number>,
  storedBox: ChunkVoxelBox | null,
  target: LevelGeometry,
): ChunkBox[] {
  const range = targetRangeForStoredChange(
    stored,
    storedGrid,
    storedBox,
    target,
  );
  return range === null ? [] : chunkBoxesOfRange(range, target.chunkDataSize);
}

/** Stored patch chunks by grid position. */
export type StoredChunkLookup = (
  gridX: number,
  gridY: number,
  gridZ: number,
) => LocalPatchChunk | undefined;

/** Distinct values counted per block (see `resamplePatchBox`). */
const MAX_BLOCK_VALUES = 256;

/** One stored level to resample from. */
export interface ResampleSource {
  readonly geometry: LevelGeometry;
  readonly chunkAt: StoredChunkLookup;
}

/**
 * For each target voxel along one axis of the box: the first stored voxel it
 * covers. Every target voxel covers `blockSize` stored voxels along the axis.
 */
function storedStartsAlongAxis(
  stored: AxisMapping,
  target: AxisMapping,
  targetChunkStart: number,
  low: number,
  high: number,
  blockSize: number,
): Int32Array {
  const starts = new Int32Array(high - low + 1);
  // A finer target voxel lies inside one stored voxel: take the one holding
  // its centre. A coarser one starts at its low edge.
  const centre = blockSize === 1 && target.scale < stored.scale ? 0.5 : 0;
  for (let local = low; local <= high; ++local) {
    const model =
      target.scale * (targetChunkStart + local + centre) + target.offset;
    starts[local - low] = Math.floor(
      (model - stored.offset) / stored.scale + EPSILON,
    );
  }
  return starts;
}

/** Stored voxels one target voxel covers along `axis` (at least one). */
function blockSizeAlong(
  stored: LevelGeometry,
  target: LevelGeometry,
  axis: number,
): number {
  return Math.max(
    1,
    Math.round(target.axes[axis].scale / stored.axes[axis].scale),
  );
}

/** Stored voxels one target voxel reads from `stored` (its block's volume). */
export function storedVoxelsPerTargetVoxel(
  stored: LevelGeometry,
  target: LevelGeometry,
): number {
  return (
    blockSizeAlong(stored, target, 0) *
    blockSizeAlong(stored, target, 1) *
    blockSizeAlong(stored, target, 2)
  );
}

/** Per-source lookup tables for one box, and its last chunk looked up. */
interface SourcePlan {
  readonly chunkAt: StoredChunkLookup;
  cachedGridX: number;
  cachedGridY: number;
  cachedGridZ: number;
  cachedChunk: LocalPatchChunk | undefined;
  readonly gridSize: Triple;
  readonly blockSize: Triple;
  readonly blockVolume: number;
  readonly starts: readonly [Int32Array, Int32Array, Int32Array];
}

function planSource(
  source: ResampleSource,
  target: LevelGeometry,
  targetGrid: ArrayLike<number>,
  box: ChunkVoxelBox,
): SourcePlan {
  const blockSize: Triple = [
    blockSizeAlong(source.geometry, target, 0),
    blockSizeAlong(source.geometry, target, 1),
    blockSizeAlong(source.geometry, target, 2),
  ];
  const startsAlong = (axis: number) =>
    storedStartsAlongAxis(
      source.geometry.axes[axis],
      target.axes[axis],
      targetGrid[axis] * target.chunkDataSize[axis],
      boxLow(box, axis),
      boxHigh(box, axis),
      blockSize[axis],
    );
  const starts: SourcePlan["starts"] = [
    startsAlong(0),
    startsAlong(1),
    startsAlong(2),
  ];
  return {
    chunkAt: source.chunkAt,
    cachedGridX: NaN,
    cachedGridY: NaN,
    cachedGridZ: NaN,
    cachedChunk: undefined,
    gridSize: source.geometry.chunkDataSize,
    blockSize,
    blockVolume: blockSize[0] * blockSize[1] * blockSize[2],
    starts,
  };
}

/**
 * Recompute `box` (chunk-local, inclusive, inside the chunk's real extent) of
 * `targetChunk`, the target level's chunk at `targetGrid`, from `sources` in
 * priority order. Voxels outside `box` are left as they are. Returns whether
 * any voxel of `box` is patched.
 *
 * Hot path while painting zoomed out: runs per redrawn chunk box, so it and
 * its helpers keep tight scalar loops and inline index math (CQ5). Measured
 * (patch_resampling.benchmark.ts, one-slice box of a radius-96 stroke): 0.9 ms
 * zoomed out (2× downsampling), 0.24 ms one level finer (nearest copy).
 */
export function resamplePatchBox(
  sources: readonly ResampleSource[],
  target: LevelGeometry,
  targetGrid: ArrayLike<number>,
  targetChunk: LocalPatchChunk,
  box: ChunkVoxelBox,
): boolean {
  const plans = sources.map((source) =>
    planSource(source, target, targetGrid, box),
  );
  if (plans.length === 1 && plans[0].blockVolume === 1) {
    return copyNearestBox(plans[0], targetChunk, box);
  }
  // Distinct edit values seen in one block and how often. A block holds up
  // to MAX_LEVEL_RATIO³ voxels, but strokes carry few values: past
  // MAX_BLOCK_VALUES distinct values the rest are not counted (no single
  // value can then hold half of so mixed a block anyway).
  const blockValues = new BigUint64Array(MAX_BLOCK_VALUES);
  const blockCounts = new Int32Array(MAX_BLOCK_VALUES);
  const [targetSizeX, targetSizeY] = targetChunk.chunkDataSize;
  let anyPatched = false;
  for (let z = box.z0; z <= box.z1; ++z) {
    for (let y = box.y0; y <= box.y1; ++y) {
      for (let x = box.x0; x <= box.x1; ++x) {
        const targetIndex = x + targetSizeX * (y + targetSizeY * z);
        let value: bigint | undefined;
        for (const plan of plans) {
          const distinct = voteBlock(
            plan,
            x - box.x0,
            y - box.y0,
            z - box.z0,
            blockValues,
            blockCounts,
          );
          value = majorityValue(
            distinct,
            blockValues,
            blockCounts,
            plan.blockVolume,
          );
          if (value !== undefined) break;
        }
        if (value !== undefined) {
          targetChunk.data[targetIndex] = value;
          targetChunk.patched[targetIndex] = 1;
          anyPatched = true;
        } else {
          targetChunk.data[targetIndex] = 0n;
          targetChunk.patched[targetIndex] = 0;
        }
      }
    }
  }
  return anyPatched;
}

/**
 * The value at least half of a block of `blockVolume` stored voxels carries
 * (the first `distinct` entries of `values` / `counts`), or `undefined`.
 */
function majorityValue(
  distinct: number,
  values: BigUint64Array,
  counts: Int32Array,
  blockVolume: number,
): bigint | undefined {
  let bestSlot = -1;
  for (let slot = 0; slot < distinct; ++slot) {
    if (bestSlot === -1 || counts[slot] > counts[bestSlot]) bestSlot = slot;
  }
  if (bestSlot === -1 || counts[bestSlot] * 2 < blockVolume) return undefined;
  return values[bestSlot];
}

/**
 * `resamplePatchBox` for one source whose target voxels each lie in one
 * stored voxel (a finer or equal level): a straight nearest copy, row by row,
 * with the x positions computed once per box. Several times faster than the
 * general path, which a full-chunk rebuild (undo, a fill, a level's first
 * show) needs.
 *
 * Hot path (see `resamplePatchBox`).
 */
function copyNearestBox(
  plan: SourcePlan,
  targetChunk: LocalPatchChunk,
  box: ChunkVoxelBox,
): boolean {
  const [gridSizeX, gridSizeY, gridSizeZ] = plan.gridSize;
  const [targetSizeX, targetSizeY] = targetChunk.chunkDataSize;
  const width = box.x1 - box.x0 + 1;
  const gridXs = new Int32Array(width);
  const localXs = new Int32Array(width);
  for (let offset = 0; offset < width; ++offset) {
    const storedX = plan.starts[0][offset];
    gridXs[offset] = Math.floor(storedX / gridSizeX);
    localXs[offset] = storedX - gridXs[offset] * gridSizeX;
  }
  let anyPatched = false;
  for (let z = box.z0; z <= box.z1; ++z) {
    const storedZ = plan.starts[2][z - box.z0];
    const gridZ = Math.floor(storedZ / gridSizeZ);
    const localZ = storedZ - gridZ * gridSizeZ;
    for (let y = box.y0; y <= box.y1; ++y) {
      const storedY = plan.starts[1][y - box.y0];
      const gridY = Math.floor(storedY / gridSizeY);
      const localY = storedY - gridY * gridSizeY;
      const rowStart = targetSizeX * (y + targetSizeY * z);
      let chunkGridX = NaN;
      let chunk: LocalPatchChunk | undefined;
      let rowBase = 0;
      let rowInside = false;
      for (let offset = 0; offset < width; ++offset) {
        const targetIndex = rowStart + box.x0 + offset;
        const gridX = gridXs[offset];
        if (gridX !== chunkGridX) {
          chunkGridX = gridX;
          chunk = plan.chunkAt(gridX, gridY, gridZ);
          if (chunk !== undefined) {
            const [chunkSizeX, chunkSizeY, chunkSizeZ] = chunk.chunkDataSize;
            rowInside = localY < chunkSizeY && localZ < chunkSizeZ;
            rowBase = chunkSizeX * (localY + chunkSizeY * localZ);
          }
        }
        const localX = localXs[offset];
        if (
          chunk === undefined ||
          !rowInside ||
          localX >= chunk.chunkDataSize[0] ||
          chunk.patched[rowBase + localX] !== 1
        ) {
          targetChunk.data[targetIndex] = 0n;
          targetChunk.patched[targetIndex] = 0;
          continue;
        }
        targetChunk.data[targetIndex] = chunk.data[rowBase + localX];
        targetChunk.patched[targetIndex] = 1;
        anyPatched = true;
      }
    }
  }
  return anyPatched;
}

/**
 * Count the edit values in the stored block of the target voxel at box offset
 * (`offsetX`, `offsetY`, `offsetZ`). Stored voxels outside a stored chunk's
 * real (possibly clipped) extent hold nothing. Returns the number of distinct
 * values written to `blockValues` / `blockCounts`.
 *
 * Hot path (see `resamplePatchBox`).
 */
function voteBlock(
  plan: SourcePlan,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
  blockValues: BigUint64Array,
  blockCounts: Int32Array,
): number {
  const [gridSizeX, gridSizeY, gridSizeZ] = plan.gridSize;
  const [blockX, blockY, blockZ] = plan.blockSize;
  const startX = plan.starts[0][offsetX];
  const startY = plan.starts[1][offsetY];
  const startZ = plan.starts[2][offsetZ];
  let distinct = 0;
  for (let blockOffsetZ = 0; blockOffsetZ < blockZ; ++blockOffsetZ) {
    const storedZ = startZ + blockOffsetZ;
    const gridZ = Math.floor(storedZ / gridSizeZ);
    const localZ = storedZ - gridZ * gridSizeZ;
    for (let blockOffsetY = 0; blockOffsetY < blockY; ++blockOffsetY) {
      const storedY = startY + blockOffsetY;
      const gridY = Math.floor(storedY / gridSizeY);
      const localY = storedY - gridY * gridSizeY;
      for (let blockOffsetX = 0; blockOffsetX < blockX; ++blockOffsetX) {
        const storedX = startX + blockOffsetX;
        const gridX = Math.floor(storedX / gridSizeX);
        const localX = storedX - gridX * gridSizeX;
        if (
          gridX !== plan.cachedGridX ||
          gridY !== plan.cachedGridY ||
          gridZ !== plan.cachedGridZ
        ) {
          plan.cachedGridX = gridX;
          plan.cachedGridY = gridY;
          plan.cachedGridZ = gridZ;
          plan.cachedChunk = plan.chunkAt(gridX, gridY, gridZ);
        }
        const chunk = plan.cachedChunk;
        if (chunk === undefined) continue;
        const [chunkSizeX, chunkSizeY, chunkSizeZ] = chunk.chunkDataSize;
        if (
          localX >= chunkSizeX ||
          localY >= chunkSizeY ||
          localZ >= chunkSizeZ
        ) {
          continue;
        }
        const index = localX + chunkSizeX * (localY + chunkSizeY * localZ);
        if (chunk.patched[index] !== 1) continue;
        const value = chunk.data[index];
        let slot = 0;
        while (slot < distinct && blockValues[slot] !== value) ++slot;
        if (slot === distinct) {
          if (distinct === MAX_BLOCK_VALUES) continue;
          blockValues[slot] = value;
          blockCounts[slot] = 0;
          ++distinct;
        }
        ++blockCounts[slot];
      }
    }
  }
  return distinct;
}
