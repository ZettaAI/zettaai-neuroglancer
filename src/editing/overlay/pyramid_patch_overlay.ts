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
 * @file The contract between the base segmentation render layer and the
 * edit overlay of one layer across its pyramid levels (TM-524). Kept minimal
 * so the render layer depends on no edit-session types.
 */

import type { PatchedMaskProvider } from "#src/editing/shaders/patched_mask_provider.js";
import type { NullarySignal } from "#src/util/signal.js";

/**
 * The parts of a neuroglancer single-resolution source (one pyramid level)
 * the overlay needs to place edits on it (TM-524): its chunk source, its
 * chunk layout and volume bounds, and the transform from its chunk voxels to
 * the multiscale (model) space.
 */
export interface PatchOverlayLevelSource {
  readonly chunkToMultiscaleTransform: Float32Array;
  readonly chunkSource: {
    readonly spec: {
      readonly rank: number;
      readonly chunkDataSize: ArrayLike<number>;
      /** Inclusive lower voxel bound; 0 when absent. */
      readonly lowerVoxelBound?: ArrayLike<number>;
      /** Exclusive upper voxel bound; edge chunks are clipped there. */
      readonly upperVoxelBound?: ArrayLike<number>;
    };
  };
}

/**
 * The edit overlay of one segmentation layer for every pyramid level it is
 * drawn at (TM-524). Edits are stored at the session's resolutions; a level
 * at another resolution gets them resampled to its own grid, so a stroke
 * shows where it was painted at any zoom.
 */
export interface PyramidPatchOverlay {
  /** Fires whenever any level's patches change (redraw trigger). */
  readonly changed: NullarySignal;

  /**
   * The provider for chunks of `chunkSource` (one pyramid level's chunk
   * source, as listed by `observeLevels`); a source it does not know gets a
   * provider with no patches. `drawnFrame`: the viewer's frame number when
   * called while drawing (not for a value lookup); it paces rebuilding and
   * keeps the level's resampled patches alive.
   */
  forChunkSource(
    chunkSource: object | undefined,
    drawnFrame: number | undefined,
  ): PatchedMaskProvider;

  /**
   * Every level the layer can draw, as its sources are listed: the overlay
   * needs the transform of the levels edits are stored at, which may not be
   * drawn at the current zoom.
   */
  observeLevels(sources: Iterable<PatchOverlayLevelSource>): void;
}
