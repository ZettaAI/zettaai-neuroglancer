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
 * @file The session resolution of a pyramid level: the edit library's
 * `Resolution` of a neuroglancer single-resolution source, from the source's
 * voxel size relative to its data source's model space. Used by the
 * edit-session resolution lock (`allowed_source_predicate.ts`) and by the
 * edit overlay, which keeps one store per resolution (TM-524).
 */

import type { Resolution } from "@zettaai/edit-session";
import { Resolution as ResolutionFactory } from "@zettaai/edit-session";

import type { PatchOverlayLevelSource } from "#src/editing/overlay/pyramid_patch_overlay.js";
import { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";

/** The session resolution of `source`, given its model space's voxel size in nm. */
export function resolutionOfLevel(
  source: PatchOverlayLevelSource,
  modelResolutionNm: readonly [number, number, number],
): Resolution {
  const transform = source.chunkToMultiscaleTransform;
  const rank = source.chunkSource.spec.rank;
  const stride = rank + 1;
  const voxelSizeNm: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    // A flipped axis has a negative scale; its voxels are as large.
    const relativeScale = Math.abs(transform[stride * i + i]) || 1;
    voxelSizeNm[i] = modelResolutionNm[i] * relativeScale;
  }
  return ResolutionFactory.from(voxelSizeNm);
}

/** Voxel size in nm of a loaded data source's model space. */
export function modelResolutionNmOf(
  loadState: LoadedLayerDataSource,
): readonly [number, number, number] {
  const { scales, units } = loadState.dataSource.modelTransform.outputSpace;
  const result: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3 && i < scales.length; ++i) {
    const scale = scales[i];
    const unit = units[i];
    result[i] = unit === "m" ? scale * 1e9 : scale;
  }
  return result;
}

/** The session resolution of each pyramid level of one layer. */
export interface LevelResolutions {
  resolutionOf(source: PatchOverlayLevelSource): Resolution;
}

interface LayerLookup {
  getLayerByName(name: string):
    | {
        readonly layer: {
          readonly dataSources: readonly { readonly loadState: unknown }[];
        } | null;
      }
    | undefined;
}

/**
 * Session resolutions of the levels of the layer named `layerName`, looked up
 * by name on every call: restoring the viewer state recreates the layer (and
 * its handle), and the edit overlay holding this outlives both.
 *
 * A class, not a closure: a closure created where a session is opened would
 * share that scope's context and keep the session alive.
 */
export class NamedLayerLevelResolutions implements LevelResolutions {
  constructor(
    private readonly layers: LayerLookup,
    private readonly layerName: string,
  ) {}

  resolutionOf(source: PatchOverlayLevelSource): Resolution {
    const dataSources =
      this.layers.getLayerByName(this.layerName)?.layer?.dataSources ?? [];
    for (const { loadState } of dataSources) {
      if (loadState instanceof LoadedLayerDataSource) {
        return resolutionOfLevel(source, modelResolutionNmOf(loadState));
      }
    }
    return resolutionOfLevel(source, [1, 1, 1]);
  }
}
