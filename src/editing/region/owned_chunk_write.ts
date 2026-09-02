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
 * @file Which voxels of a chunk a save is allowed to write, as an immutable
 * value shared by the write path and the read-back verifier.
 *
 * A painting task's bbox comes from sampling and does not land on the layer's
 * chunk grid, so a boundary chunk is owned by two tasks at once. Uploading such
 * a chunk whole overwrites the neighbour's half — with this session's start-up
 * baseline for voxels it never touched, and with paint that escaped the region
 * for voxels near a boundary stroke (the brush rasteriser clamps to the chunk,
 * not to the region; the session's bbox shader merely hides the overspill).
 * Both are the neighbour's data, and both are lost.
 *
 * The fix is to write only the owned sub-box. That only holds together if the
 * VERIFIER agrees: read-back compares content hashes, so hashing the whole
 * chunk while writing a sub-box can never match once a neighbour has touched
 * their half — the save would report "couldn't be confirmed" forever.
 *
 * So the owned box is computed ONCE, by {@link planOwnedWrite}, and handed
 * unchanged to both consumers. {@link ownedRegionBytes} and
 * {@link ownedRegionHash} are the only two ways to read a chunk through it, and
 * both sides call them. Clipping one side and not the other is not expressible.
 *
 * LIFETIME: an {@link OwnedChunkWrite} is created with the bytes it describes,
 * is immutable, and dies with them. Verification reuses the record it was
 * given; a retry re-derives from the SAME frozen snapshot over the SAME bytes,
 * which yields the same box and hash. What must never happen is re-deriving
 * against a DIFFERENT region: a shrunk one writes less than the original POST
 * already wrote and could never match the pinned hash, and a grown one writes
 * voxels that save was never authorised to touch. Nothing here holds an
 * `EditSession`; the only session-derived input is a frozen box of six numbers.
 *
 * WHY THE WRITER AND THE VERIFIER CANNOT DISAGREE. They do not share an object:
 * `NgSaveTarget` plans the library's payload while `EditSessionHost` plans its
 * own dirty-chunk snapshot. They agree because of three properties, and a
 * refactor that breaks any one of them reintroduces the bug this file exists to
 * prevent:
 *   1. IDENTITY of inputs. Both call this module's `planOwnedWrite`, resolve
 *      through the same `NgLayerMetadataSource` instance, and read the same
 *      `SessionRegionSnapshot` object. `collectDirtyChunks` hands both sides
 *      the SAME `ChunkContentRef` — `contentRefFromBuffer` captures an
 *      immutable clone that `retain()` closes over — not two equal ones.
 *   2. ATOMICITY. There is not one macrotask boundary between the host's
 *      collect and the library's collect inside `runSave`: `retain()` is an
 *      already-resolved promise, `NgLayerMetadataSource.resolve` is `async`
 *      with no `await` in its body, and `EditSession.save` runs synchronously
 *      into its first `differingSlots()` read. Every way the overlay can change
 *      — a paint tile committing, undo, a stroke release — is a macrotask, and
 *      macrotasks cannot interleave with a draining microtask queue. **Keep
 *      that window microtask-only.** One genuinely-async `resolve()`, or one
 *      `await` on real I/O added to `planOwnedWrites`, opens the hole silently.
 *   3. SAFE DIRECTION. With no explicit layer filter the library filters on its
 *      dirty-layer set while the host takes everything, so the library's set is
 *      a SUBSET of the host's. The dangerous direction — the library writing a
 *      chunk the host never verifies — is therefore unreachable.
 */

import type {
  ChunkCoord,
  LayerMetadata,
  SavedChunk,
  ScaleMetadata,
  SessionVoxelBounds,
} from "@zettaai/edit-session";
import { bytesPerVoxel, fnv1aHashView } from "@zettaai/edit-session";

export type Vec3 = [number, number, number];

/** A half-open voxel box: `start` inclusive, `end` exclusive. */
export interface VoxelBoxBounds {
  readonly start: Vec3;
  readonly end: Vec3;
}

/**
 * Where the owned part of a chunk sits, and how to index it. Everything
 * {@link ownedRegionBytes} needs and nothing it does not — so the byte
 * accessors cannot be handed a half-built region and quietly read a hash that
 * has not been computed yet.
 */
export interface ChunkOwnedGeometry {
  /** The chunk grid both sides index with. */
  readonly chunkDataSize: readonly [number, number, number];
  /** Bytes per voxel position, channels EXCLUDED — see {@link ownedRegionBytes}. */
  readonly bytesPerVoxel: number;
  readonly channels: number;
  /** The chunk's own absolute voxel box. */
  readonly chunkBox: VoxelBoxBounds;
  /** The owned part, absolute. Never empty. */
  readonly ownedBox: VoxelBoxBounds;
  /** True when {@link ownedBox} is the whole chunk — the aligned fast path. */
  readonly coversWholeChunk: boolean;
}

/** {@link ChunkOwnedGeometry} plus the hash of the bytes it selects. */
export interface OwnedRegion extends ChunkOwnedGeometry {
  /** `ownedRegionHash(chunk.bytes, geometry)`, pinned at creation. */
  readonly hash: string;
}

/** A dirty chunk paired with the region of it this save may write. */
export interface OwnedChunkWrite extends SavedChunk {
  readonly owned: OwnedRegion;
}

/** Why a dirty chunk produced no write. */
export type OwnedWriteRefusal =
  | { readonly kind: "chunk-outside-edit-region" }
  | { readonly kind: "no-edit-region-for-scale" };

export type OwnedWritePlan =
  | { readonly write: OwnedChunkWrite }
  | { readonly refusal: OwnedWriteRefusal };

/**
 * Absolute voxel box of a chunk:
 *   start = voxelOffset + chunkCoord * chunkDataSize
 *   end   = start + chunkDataSize
 */
export function chunkVoxelBox(
  chunkCoord: ChunkCoord,
  chunkDataSize: readonly [number, number, number],
  voxelOffset: readonly [number, number, number],
): VoxelBoxBounds {
  const coord: Vec3 = [chunkCoord.x, chunkCoord.y, chunkCoord.z];
  const start = coord.map(
    (index, axis) => voxelOffset[axis] + index * chunkDataSize[axis],
  ) as Vec3;
  const end = start.map((lo, axis) => lo + chunkDataSize[axis]) as Vec3;
  return { start, end };
}

/**
 * Intersect a chunk's box with the session region. `bounds` is the region in
 * this scale's voxel grid — not a per-chunk box — so this intersection is the
 * per-chunk part. Returns `undefined` when nothing of the chunk is owned.
 */
export function clipToSessionBounds(
  chunkBox: VoxelBoxBounds,
  bounds: SessionVoxelBounds,
): VoxelBoxBounds | undefined {
  const regionStart: Vec3 = [bounds.loX, bounds.loY, bounds.loZ];
  const regionEnd: Vec3 = [bounds.hiX, bounds.hiY, bounds.hiZ];
  const start = chunkBox.start.map((lo, axis) =>
    Math.max(lo, regionStart[axis]),
  ) as Vec3;
  const end = chunkBox.end.map((hi, axis) =>
    Math.min(hi, regionEnd[axis]),
  ) as Vec3;
  if (start.some((lo, axis) => lo >= end[axis])) return undefined;
  return { start, end };
}

/**
 * Copy one channel-plane's sub-box out of an X-fastest chunk buffer.
 *
 * NG's chunk buffer is channel-SLOWEST: `uncompressed_chunk_format.ts` strides
 * over `[x, y, z, channel]` multiplying by `chunkDataSize[i]`, so channel `c`
 * occupies the whole plane at `c * sizeX * sizeY * sizeZ`. Channels are
 * therefore NOT interleaved per voxel, and a sub-box has to be gathered one
 * plane at a time — which is what {@link ownedRegionBytes} does.
 */
function extractPlaneSubBox(
  chunkBytes: Uint8Array,
  planeByteOffset: number,
  chunkDataSize: readonly [number, number, number],
  bytesPerVoxelValue: number,
  offset: readonly [number, number, number],
  size: readonly [number, number, number],
  destination: Uint8Array,
  destinationOffset: number,
): number {
  const [chunkSizeX, chunkSizeY] = chunkDataSize;
  const [offsetX, offsetY, offsetZ] = offset;
  const [sizeX, sizeY, sizeZ] = size;

  const rowBytes = sizeX * bytesPerVoxelValue;
  const chunkRowBytes = chunkSizeX * bytesPerVoxelValue;
  const chunkPlaneBytes = chunkRowBytes * chunkSizeY;
  const rowStartX = offsetX * bytesPerVoxelValue;

  let writeOffset = destinationOffset;
  for (let z = 0; z < sizeZ; z++) {
    const sliceStart = planeByteOffset + (offsetZ + z) * chunkPlaneBytes;
    for (let y = 0; y < sizeY; y++) {
      const readStart = sliceStart + (offsetY + y) * chunkRowBytes + rowStartX;
      destination.set(
        chunkBytes.subarray(readStart, readStart + rowBytes),
        writeOffset,
      );
      writeOffset += rowBytes;
    }
  }
  return writeOffset;
}

/**
 * The owned voxels of `view`, in the same X-fastest layout `/cutout` consumes.
 *
 * Returns the buffer UNCOPIED when the region is the whole chunk — the caller
 * copies if it needs to outlive the overlay buffer.
 */
export function ownedRegionBytes(
  view: ArrayBufferView,
  owned: ChunkOwnedGeometry,
): Uint8Array {
  const chunkBytes = new Uint8Array(
    view.buffer,
    view.byteOffset,
    view.byteLength,
  );
  if (owned.coversWholeChunk) return chunkBytes;

  const { chunkDataSize, bytesPerVoxel: voxelBytes, channels } = owned;
  const offset = owned.ownedBox.start.map(
    (lo, axis) => lo - owned.chunkBox.start[axis],
  ) as Vec3;
  const size = owned.ownedBox.end.map(
    (hi, axis) => hi - owned.ownedBox.start[axis],
  ) as Vec3;

  const planeBytes =
    chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2] * voxelBytes;
  const extracted = new Uint8Array(
    size[0] * size[1] * size[2] * voxelBytes * channels,
  );
  let writeOffset = 0;
  for (let channel = 0; channel < channels; channel++) {
    writeOffset = extractPlaneSubBox(
      chunkBytes,
      channel * planeBytes,
      chunkDataSize,
      voxelBytes,
      offset,
      size,
      extracted,
      writeOffset,
    );
  }
  return extracted;
}

/** Content hash of the owned voxels only. The one comparison both sides make. */
export function ownedRegionHash(
  view: ArrayBufferView,
  owned: ChunkOwnedGeometry,
): string {
  return fnv1aHashView(ownedRegionBytes(view, owned));
}

/**
 * Pair a dirty chunk with the region of it this save owns, or refuse it.
 *
 * `ownedBox` is non-empty by construction, so "an empty owned box" is
 * unrepresentable downstream and no consumer needs a skip branch that could be
 * miscounted as a successful write.
 */
export function planOwnedWrite(
  chunk: SavedChunk,
  metadata: LayerMetadata,
  scale: ScaleMetadata,
  bounds: SessionVoxelBounds | undefined,
): OwnedWritePlan {
  if (bounds === undefined)
    return { refusal: { kind: "no-edit-region-for-scale" } };

  const chunkBox = chunkVoxelBox(
    chunk.chunkCoord,
    scale.chunkDataSize,
    scale.voxelOffset,
  );
  const ownedBox = clipToSessionBounds(chunkBox, bounds);
  if (ownedBox === undefined) {
    return { refusal: { kind: "chunk-outside-edit-region" } };
  }

  const coversWholeChunk = ownedBox.start.every(
    (lo, axis) =>
      lo === chunkBox.start[axis] && ownedBox.end[axis] === chunkBox.end[axis],
  );
  const geometry: ChunkOwnedGeometry = {
    chunkDataSize: scale.chunkDataSize,
    bytesPerVoxel: bytesPerVoxel(metadata.voxelDataType),
    channels: metadata.channels,
    chunkBox,
    ownedBox,
    coversWholeChunk,
  };
  // A whole-chunk region hashes exactly what `contentRefFromBuffer` already
  // hashed, so reuse it — that is the overwhelming majority of chunks, and it
  // keeps this off the hot path for interior chunks.
  const hash = coversWholeChunk
    ? chunk.contentRef.hash
    : ownedRegionHash(chunk.bytes.asView(), geometry);
  return { write: { ...chunk, owned: { ...geometry, hash } } };
}
