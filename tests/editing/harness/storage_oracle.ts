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
 * Independent read of what a save actually persisted (TM-331).
 *
 * The save e2e must not let the app grade itself, so the stored voxels are read
 * from the Node side through the web API's production `GET /painting/cutout`
 * (CloudVolume, a different decoder from NG's) — never through the page.
 * Comparing a read before and after a save yields exactly the voxels the save
 * changed, which the spec matches against what the app showed as painted.
 */

import { gunzipSync } from "node:zlib";

import type { Vec3 } from "#tests/editing/harness/build_ng_state.js";

export type StoredDataType = "uint8" | "uint16" | "uint32" | "uint64";

/** Voxels of one bbox, X fastest, as decimal strings (uint64-safe). */
export interface StoredVolume {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly values: readonly string[];
}

/** One voxel in absolute (global) coordinates. */
export interface StoredVoxel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly value: string;
}

function cutoutQuery(
  layerPath: string,
  start: Vec3,
  end: Vec3,
  resolution: Vec3,
): string {
  const params = new URLSearchParams();
  params.append("path", layerPath);
  for (const value of start) params.append("bbox_start", String(value));
  for (const value of end) params.append("bbox_end", String(value));
  for (const value of resolution) params.append("resolution", String(value));
  return params.toString();
}

function decodeValues(bytes: Buffer, dataType: StoredDataType): string[] {
  const buffer = new Uint8Array(bytes).buffer;
  const toStrings = (values: Iterable<number | bigint>) =>
    Array.from(values, (value) => value.toString());
  switch (dataType) {
    case "uint8":
      return toStrings(new Uint8Array(buffer));
    case "uint16":
      return toStrings(new Uint16Array(buffer));
    case "uint32":
      return toStrings(new Uint32Array(buffer));
    case "uint64":
      return toStrings(new BigUint64Array(buffer));
  }
}

/**
 * Read `[start, end)` at `resolution` of `layerPath` (a `precomputed://gs://…`
 * path, as NG and the saved data name it) through the web API.
 */
export async function readStoredVolume(
  webApiUrl: string,
  opts: {
    layerPath: string;
    dataType: StoredDataType;
    start: Vec3;
    end: Vec3;
    resolution: Vec3;
  },
): Promise<StoredVolume> {
  const query = cutoutQuery(
    opts.layerPath,
    opts.start,
    opts.end,
    opts.resolution,
  );
  const response = await fetch(`${webApiUrl}/painting/cutout?${query}`);
  if (!response.ok) {
    throw new Error(
      `storage read failed: ${response.status} ${await response.text()}`,
    );
  }
  // `is_fortran` defaults to true: the bytes are X fastest, one channel.
  const raw = gunzipSync(Buffer.from(await response.arrayBuffer()));
  const values = decodeValues(raw, opts.dataType);
  const [sizeX, sizeY, sizeZ] = opts.end.map(
    (endValue, axis) => endValue - opts.start[axis],
  );
  if (values.length !== sizeX * sizeY * sizeZ) {
    throw new Error(
      `storage read returned ${values.length} voxels for a ` +
        `${sizeX}×${sizeY}×${sizeZ} bbox`,
    );
  }
  return { start: opts.start, end: opts.end, values };
}

/** The voxels whose value differs between two reads of the same bbox. */
export function changedVoxels(
  before: StoredVolume,
  after: StoredVolume,
): StoredVoxel[] {
  const sameBox =
    before.start.every((value, axis) => value === after.start[axis]) &&
    before.end.every((value, axis) => value === after.end[axis]);
  if (!sameBox)
    throw new Error("changedVoxels: the reads cover different boxes");
  const [startX, startY, startZ] = before.start;
  const sizeX = before.end[0] - startX;
  const sizeY = before.end[1] - startY;
  const changed: StoredVoxel[] = [];
  before.values.forEach((beforeValue, linearIndex) => {
    const afterValue = after.values[linearIndex];
    if (afterValue === beforeValue) return;
    changed.push({
      x: startX + (linearIndex % sizeX),
      y: startY + (Math.floor(linearIndex / sizeX) % sizeY),
      z: startZ + Math.floor(linearIndex / (sizeX * sizeY)),
      value: afterValue,
    });
  });
  return changed;
}

/** How many voxels of `volume` hold `value`. */
export function countValue(volume: StoredVolume, value: string): number {
  return volume.values.filter((stored) => stored === value).length;
}

/**
 * The read-back signature of a voxel set: FNV-1a (32-bit) over the z-major
 * sorted `x,y,z=value;` strings. MUST match `summarizePatchedVoxels`
 * (`src/editing/benchmarks/patch_readback.ts`) — pinned by
 * `tests/editing/unit/storage_oracle.spec.ts`, so storage and the app's own
 * read-back are comparable by signature.
 */
export function voxelSetSignature(voxels: readonly StoredVoxel[]): string {
  const sorted = [...voxels].sort(
    (first, second) =>
      first.z - second.z || first.y - second.y || first.x - second.x,
  );
  let hash = 0x811c9dc5 >>> 0;
  for (const voxel of sorted) {
    const entry = `${voxel.x},${voxel.y},${voxel.z}=${voxel.value};`;
    for (let i = 0; i < entry.length; i++) {
      hash ^= entry.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
