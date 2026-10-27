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
 * @file CPU side of the painted-volume texture: the class byte of every texel a
 * chunk covers.
 *
 * Each voxel's value is the same composite the 2D layer draws — the patch value
 * where the patch marks the voxel as written, the datasource baseline
 * elsewhere. A shown, non-zero value becomes its palette class; anything else
 * is empty. Downsampled texels max-pool their voxels: the first shown voxel of
 * the block decides the class, so a one-voxel stroke never vanishes.
 *
 * Every factor block lies inside one chunk (`painted_volume_extent.ts`), so a
 * chunk can rewrite its texels without touching a neighbour's.
 */

import type {
  ChunkVoxelBox,
  LocalPatchChunk,
} from "#src/editing/local_patch_chunk.js";
import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import type { PaintedVolumeSegmentPalette } from "#src/editing/painted_volume/painted_volume_segment_palette.js";
import { PAINTED_VOLUME_EMPTY_CLASS } from "#src/editing/painted_volume/painted_volume_segment_palette.js";
import type { PaintedVolumeShownSegments } from "#src/editing/painted_volume/painted_volume_shown_segments.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import { chunkBoxToTexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";

type Triple = readonly [number, number, number];

/**
 * Module-local copy for the per-voxel loops: an imported binding can compile
 * to a namespace getter (vite's SSR transform does this), which made the
 * kernel five times slower.
 */
const EMPTY_CLASS = PAINTED_VOLUME_EMPTY_CLASS;

/** Decoded datasource chunk, as `readDatasourceBaseline` returns it. */
export type BaselineVoxelView =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigUint64Array;

/** One chunk's voxels: its datasource baseline and, if painted, its patch. */
export interface PaintedVolumeChunkVoxels {
  /** Absolute voxel of the chunk's local (0, 0, 0), e.g. `ChunkGrid.chunkOriginOf`. */
  readonly origin: Triple;
  /** `chunkDataSize`; both views hold this many voxels, x fastest. */
  readonly size: Triple;
  readonly baseline: BaselineVoxelView;
  /** `undefined` when nothing in the chunk is patched: the composite is the baseline. */
  readonly patch: LocalPatchChunk | undefined;
}

/** Class bytes for `texelBox`, x fastest, ready for `texSubImage3D`. */
export interface OccupancyBoxWrite {
  readonly texelBox: TexelBox;
  readonly bytes: Uint8Array;
  /** At least one texel of the box holds a shown segment. */
  readonly occupied: boolean;
}

/**
 * Compute the class bytes of every texel touched by the chunk-local inclusive
 * `chunkLocalBox`. The box is widened to whole factor blocks, so a texel is
 * always pooled from all of its voxels — an erase in part of a block cannot
 * leave a stale class behind. Returns `undefined` when the box is outside the
 * texture. `scratch` is reused for `bytes` when it is large enough.
 */
export function writeOccupancyForBox(
  chunk: PaintedVolumeChunkVoxels,
  chunkLocalBox: ChunkVoxelBox,
  extent: PaintedVolumeExtent,
  shown: PaintedVolumeShownSegments,
  palette: PaintedVolumeSegmentPalette,
  scratch?: Uint8Array,
): OccupancyBoxWrite | undefined {
  const texelBox = chunkBoxToTexelBox(extent, chunk.origin, chunkLocalBox);
  if (texelBox === undefined) return undefined;
  const bytes = zeroedBytes(texelCountOf(texelBox), scratch);
  const occupied = poolCompositeIntoTexels(
    compositeSource(chunk),
    blockScanOf(chunk, extent, texelBox),
    rememberedClassOfShown(shown, palette),
    bytes,
  );
  return { texelBox, bytes, occupied };
}

/** Does any voxel of the chunk's composite hold a shown segment? */
export function chunkHasShownVoxel(
  chunk: PaintedVolumeChunkVoxels,
  shown: PaintedVolumeShownSegments,
): boolean {
  const [sizeX, sizeY, sizeZ] = chunk.size;
  return anyCompositeVoxel(
    compositeSource(chunk),
    sizeX * sizeY * sizeZ,
    (low, high) => shown.has(idOf(low, high)),
  );
}

/**
 * The composite's voxels as 32-bit words. The patch is always (low, high)
 * pairs; a baseline is pairs only when it is 64-bit.
 */
interface CompositeSource {
  readonly baselineWords: ArrayLike<number>;
  readonly baselineIsWide: boolean;
  readonly patchWords: Uint32Array | undefined;
  readonly patched: Uint8Array | undefined;
}

function compositeSource(chunk: PaintedVolumeChunkVoxels): CompositeSource {
  const { baseline, patch } = chunk;
  const baselineIsWide = baseline instanceof BigUint64Array;
  return {
    baselineWords: baselineIsWide ? wordsOf(baseline) : baseline,
    baselineIsWide,
    patchWords: patch === undefined ? undefined : wordsOf(patch.data),
    patched: patch?.patched,
  };
}

function wordsOf(view: BigUint64Array): Uint32Array {
  return new Uint32Array(view.buffer, view.byteOffset, view.length * 2);
}

/** Chunk-local voxels to scan and the texel each voxel pools into. */
interface BlockScan {
  readonly chunkSizeX: number;
  readonly chunkSizeY: number;
  readonly first: Triple;
  readonly last: Triple;
  /** Texel x (relative to the box) of each scanned voxel x. */
  readonly texelColumnOfX: Int32Array;
  readonly texelRowOfY: Int32Array;
  readonly texelLayerOfZ: Int32Array;
  readonly texelBoxWidth: number;
  readonly texelBoxHeight: number;
}

/**
 * The chunk-local voxels covered by the whole factor blocks of `texelBox`,
 * clipped to the chunk, with the box-relative texel of each.
 */
function blockScanOf(
  chunk: PaintedVolumeChunkVoxels,
  extent: PaintedVolumeExtent,
  texelBox: TexelBox,
): BlockScan {
  const texelLows = [texelBox.x0, texelBox.y0, texelBox.z0];
  const texelHighs = [texelBox.x1, texelBox.y1, texelBox.z1];
  const first: [number, number, number] = [0, 0, 0];
  const last: [number, number, number] = [0, 0, 0];
  const texelOfVoxel: Int32Array[] = [];
  for (const axis of [0, 1, 2]) {
    const factor = extent.factor[axis];
    const blockStart = extent.textureOrigin[axis] - chunk.origin[axis];
    first[axis] = Math.max(0, blockStart + texelLows[axis] * factor);
    last[axis] = Math.min(
      chunk.size[axis] - 1,
      blockStart + (texelHighs[axis] + 1) * factor - 1,
    );
    const texels = new Int32Array(Math.max(0, last[axis] - first[axis] + 1));
    for (let i = 0; i < texels.length; ++i) {
      const localVoxel = first[axis] + i;
      texels[i] =
        Math.floor((localVoxel - blockStart) / factor) - texelLows[axis];
    }
    texelOfVoxel.push(texels);
  }
  return {
    chunkSizeX: chunk.size[0],
    chunkSizeY: chunk.size[1],
    first,
    last,
    texelColumnOfX: texelOfVoxel[0],
    texelRowOfY: texelOfVoxel[1],
    texelLayerOfZ: texelOfVoxel[2],
    texelBoxWidth: texelBox.x1 - texelBox.x0 + 1,
    texelBoxHeight: texelBox.y1 - texelBox.y0 + 1,
  };
}

/**
 * Hot path: runs per voxel over every painted box and over the whole region on
 * a full refill; measured in painted_volume_occupancy.benchmark.ts. Tight
 * scalars on purpose (CQ5); ids stay split into 32-bit words to avoid a BigInt
 * per voxel, and a texel stops being scanned once a class lands in it.
 */
function poolCompositeIntoTexels(
  source: CompositeSource,
  scan: BlockScan,
  classOf: (low: number, high: number) => number,
  bytes: Uint8Array,
): boolean {
  const { baselineWords, baselineIsWide, patchWords, patched } = source;
  const { chunkSizeX, chunkSizeY, first, last, texelBoxWidth } = scan;
  const { texelColumnOfX, texelRowOfY, texelLayerOfZ, texelBoxHeight } = scan;
  let lastLow = 0;
  let lastHigh = 0;
  let lastClass = EMPTY_CLASS;
  let occupied = false;
  for (let z = first[2]; z <= last[2]; ++z) {
    const texelLayer = texelLayerOfZ[z - first[2]] * texelBoxHeight;
    for (let y = first[1]; y <= last[1]; ++y) {
      const texelRow = (texelLayer + texelRowOfY[y - first[1]]) * texelBoxWidth;
      let voxel = (z * chunkSizeY + y) * chunkSizeX + first[0];
      for (let x = first[0]; x <= last[0]; ++x, ++voxel) {
        const texel = texelRow + texelColumnOfX[x - first[0]];
        if (bytes[texel] !== EMPTY_CLASS) continue;
        let low: number;
        let high: number;
        if (patched !== undefined && patched[voxel] !== 0) {
          low = patchWords![2 * voxel];
          high = patchWords![2 * voxel + 1];
        } else if (baselineIsWide) {
          low = baselineWords[2 * voxel];
          high = baselineWords[2 * voxel + 1];
        } else {
          low = baselineWords[voxel] >>> 0;
          high = 0;
        }
        if (low === 0 && high === 0) continue;
        if (low !== lastLow || high !== lastHigh) {
          lastLow = low;
          lastHigh = high;
          lastClass = classOf(low, high);
        }
        if (lastClass === EMPTY_CLASS) continue;
        bytes[texel] = lastClass;
        occupied = true;
      }
    }
  }
  return occupied;
}

/**
 * Hot path (scans a whole chunk, exits on the first match); same word reads as
 * {@link poolCompositeIntoTexels}.
 */
function anyCompositeVoxel(
  source: CompositeSource,
  volume: number,
  matches: (low: number, high: number) => boolean,
): boolean {
  const { baselineWords, baselineIsWide, patchWords, patched } = source;
  let lastLow = 0;
  let lastHigh = 0;
  let lastMatch = false;
  for (let voxel = 0; voxel < volume; ++voxel) {
    let low: number;
    let high: number;
    if (patched !== undefined && patched[voxel] !== 0) {
      low = patchWords![2 * voxel];
      high = patchWords![2 * voxel + 1];
    } else if (baselineIsWide) {
      low = baselineWords[2 * voxel];
      high = baselineWords[2 * voxel + 1];
    } else {
      low = baselineWords[voxel] >>> 0;
      high = 0;
    }
    if (low === 0 && high === 0) continue;
    if (low !== lastLow || high !== lastHigh) {
      lastLow = low;
      lastHigh = high;
      lastMatch = matches(low, high);
    }
    if (lastMatch) return true;
  }
  return false;
}

/**
 * Class of a voxel value: its palette class when shown, else empty. Segment
 * boundaries flip the kernel's last-value cache constantly, and each miss would
 * build BigInts, so 32-bit ids — nearly all real ids — are remembered for the
 * duration of one call.
 */
function rememberedClassOfShown(
  shown: PaintedVolumeShownSegments,
  palette: PaintedVolumeSegmentPalette,
): (low: number, high: number) => number {
  const classByLowId = new Map<number, number>();
  return (low, high) => {
    if (high === 0) {
      const remembered = classByLowId.get(low);
      if (remembered !== undefined) return remembered;
    }
    const segmentClass = shown.has(idOf(low, high))
      ? palette.classOf(low, high)
      : PAINTED_VOLUME_EMPTY_CLASS;
    if (high === 0) classByLowId.set(low, segmentClass);
    return segmentClass;
  };
}

function idOf(low: number, high: number): bigint {
  return (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
}

function texelCountOf(texelBox: TexelBox): number {
  return (
    (texelBox.x1 - texelBox.x0 + 1) *
    (texelBox.y1 - texelBox.y0 + 1) *
    (texelBox.z1 - texelBox.z0 + 1)
  );
}

function zeroedBytes(length: number, scratch: Uint8Array | undefined) {
  if (scratch === undefined || scratch.length < length) {
    return new Uint8Array(length);
  }
  const bytes = scratch.subarray(0, length);
  bytes.fill(PAINTED_VOLUME_EMPTY_CLASS);
  return bytes;
}
