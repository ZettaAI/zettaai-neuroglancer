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
 * @file The image slices z-extrapolation sends to the backend, read once and
 * kept for the next step (TM-518).
 *
 * Stepping through Z, the slice that was "next" in one run is "current" in the
 * following run, and the user almost always runs again. So the last few
 * normalized (`uint8`) slices are kept, and the tool can prefetch the slice the
 * next run will need while the user looks at the result.
 *
 * The image layer is read-only inside a session, so a slice never goes stale;
 * the cache lives as long as the session's tool. A slice whose read failed is
 * dropped, so the next run retries it.
 */

import {
  readBaselineImageSlices,
  type SliceArea,
} from "#src/editing/raster/region_slice_reader.js";
import { imageScalarToUint8 } from "#src/editing/tool_runtimes/image_scalar_to_uint8.js";
import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";
import type { ImageReadSpec } from "#src/editing/tool_runtimes/slice_propagation.js";

/**
 * Slices kept: the current and next of the last run plus one prefetched
 * slice — exactly what a "Run, Run, Run…" sequence touches.
 */
const DEFAULT_CAPACITY = 3;

export class PropagationImageSlices {
  /** Insertion order is recency order (re-inserted on use). */
  private readonly slicesByKey = new Map<string, Promise<Uint8Array>>();

  constructor(
    private readonly readChunkAt: ReadChunkAt,
    private readonly capacity = DEFAULT_CAPACITY,
  ) {}

  /**
   * The `uint8` slices of `area` at each Z of `zs` (same order). Slices not
   * already held are read together, sharing chunk reads.
   */
  read(
    image: ImageReadSpec,
    area: SliceArea,
    zs: readonly number[],
  ): Promise<Uint8Array[]> {
    const keys = zs.map((z) => sliceKey(image, area, z));
    // Take the held slices first, so adding the missing ones cannot evict them.
    // A held slice may be a prefetch still in flight; if it fails, read that
    // slice once more instead of sharing the prefetch's failure.
    const slices = keys.map((key, index) =>
      this.takeHeld(key)?.catch(() =>
        this.read(image, area, [zs[index]]).then(([slice]) => slice),
      ),
    );
    const missingIndices = [...slices.keys()].filter(
      (index) => slices[index] === undefined,
    );
    if (missingIndices.length > 0) {
      const batch = this.readSlices(
        image,
        area,
        missingIndices.map((index) => zs[index]),
      );
      missingIndices.forEach((index, batchIndex) => {
        const slice = batch.then((batchSlices) => batchSlices[batchIndex]);
        slices[index] = slice;
        this.remember(keys[index], slice);
      });
    }
    return Promise.all(slices as Promise<Uint8Array>[]);
  }

  /**
   * Start reading the slices at each Z of `zs` in the background (together, so
   * they share chunk reads), so a later {@link read} finds them ready. Failures
   * are swallowed here; the run that needs a slice reads it again and reports
   * the error.
   */
  prefetch(image: ImageReadSpec, area: SliceArea, zs: readonly number[]): void {
    this.read(image, area, zs).catch(() => {});
  }

  private readSlices(
    image: ImageReadSpec,
    area: SliceArea,
    zs: readonly number[],
  ): Promise<Uint8Array[]> {
    return readBaselineImageSlices(
      this.readChunkAt,
      image.layerId,
      image.resolution,
      image.scale,
      area,
      zs,
    ).then((slices) =>
      slices.map((values) => imageScalarToUint8(values, image.dataType)),
    );
  }

  private remember(key: string, slice: Promise<Uint8Array>): void {
    this.slicesByKey.set(key, slice);
    slice.catch(() => {
      if (this.slicesByKey.get(key) === slice) this.slicesByKey.delete(key);
    });
    for (const oldestKey of this.slicesByKey.keys()) {
      if (this.slicesByKey.size <= this.capacity) break;
      this.slicesByKey.delete(oldestKey);
    }
  }

  /** A held slice, re-inserted so the slice in use is the last to be evicted. */
  private takeHeld(key: string): Promise<Uint8Array> | undefined {
    const slice = this.slicesByKey.get(key);
    if (slice === undefined) return undefined;
    this.slicesByKey.delete(key);
    this.slicesByKey.set(key, slice);
    return slice;
  }
}

function sliceKey(image: ImageReadSpec, area: SliceArea, z: number): string {
  return [
    image.layerId,
    image.resolution,
    image.dataType,
    area.originX,
    area.originY,
    area.width,
    area.height,
    z,
  ].join("|");
}
