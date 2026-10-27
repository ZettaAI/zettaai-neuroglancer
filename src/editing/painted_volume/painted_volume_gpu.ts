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
 * @file The GPU half of one painted-volume preview, behind a seam.
 *
 * The preview controller decides what to upload and when; this owns the class
 * texture, the palette texture and the render layer that draws them. Keeping
 * GL behind `PaintedVolumeGpu` lets the controller's behaviour be specified in
 * node tests against a texture that is just a byte array.
 */

import type { Logger } from "@zettaai/edit-session";

import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import type { PaintedVolumeCursorFootprint } from "#src/editing/painted_volume/painted_volume_render_layer.js";
import { PaintedVolumeRenderLayer } from "#src/editing/painted_volume/painted_volume_render_layer.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import {
  PaintedVolumePaletteTexture,
  PaintedVolumeTexture,
} from "#src/editing/painted_volume/painted_volume_texture.js";
import type { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type { mat4 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";

type Triple = readonly [number, number, number];

/**
 * What the render layer reads every frame. The controller owns it and mutates
 * it in place, then asks for a redraw.
 */
export interface PaintedVolumeFrameState {
  readonly extent: PaintedVolumeExtent;
  texelToDisplay: mat4 | undefined;
  occupiedBox: TexelBox | undefined;
  cursorFootprint: PaintedVolumeCursorFootprint | undefined;
}

export interface PaintedVolumeGpu {
  /** The preview's own reference; attach with `addRef()`. */
  readonly renderLayer: PerspectiveViewRenderLayer;
  /** Zeroed class storage of `size` texels; `false` when the GPU refused. */
  allocate(size: Triple): boolean;
  uploadBox(texelBox: TexelBox, bytes: Uint8Array): void;
  uploadPalette(colors: Uint8Array): void;
  requestRedraw(): void;
  dispose(): void;
}

export type PaintedVolumeGpuFactory = (
  frame: PaintedVolumeFrameState,
) => PaintedVolumeGpu;

export function paintedVolumeGpuFactory(
  gl: GL,
  logger: Logger,
): PaintedVolumeGpuFactory {
  return (frame) => {
    const texture = new PaintedVolumeTexture(gl, logger);
    const palette = new PaintedVolumePaletteTexture(gl);
    const renderLayer = new PaintedVolumeRenderLayer(gl, {
      texture,
      palette,
      get extent() {
        return frame.extent;
      },
      get texelToDisplay() {
        return frame.texelToDisplay;
      },
      get occupiedBox() {
        return frame.occupiedBox;
      },
      get cursorFootprint() {
        return frame.cursorFootprint;
      },
    });
    return {
      renderLayer,
      allocate: (size) => texture.allocate(size),
      uploadBox: (texelBox, bytes) => texture.uploadBox(texelBox, bytes),
      uploadPalette: (colors) => palette.upload(colors),
      requestRedraw: () => renderLayer.redrawNeeded.dispatch(),
      dispose: () => {
        renderLayer.dispose();
        texture.dispose();
        palette.dispose();
      },
    };
  };
}
