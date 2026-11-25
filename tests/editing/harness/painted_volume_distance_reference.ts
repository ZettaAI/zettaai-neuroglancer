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
 * Reference model of the preview's per-slice distance field, for browser
 * tests: what the distance pass should store, a read-back of what it did
 * store, and GL's linear filtering of it.
 */

import { PAINTED_VOLUME_DISTANCE_RANGE } from "#src/editing/painted_volume/painted_volume_distance_field.js";
import type { GL } from "#src/webgl/context.js";

/**
 * Per texel of one slice (x fastest): the distance to the nearest texel of the
 * other kind (texels off the slice are empty), minus the half texel to the
 * outline, signed positive inside, clamped to the range — then encoded as the
 * pass stores it, `0.5 + d / (2 · range)`, on a 0..1 scale.
 */
export function referenceEncodedDistances(
  occupied: readonly boolean[],
  width: number,
  height: number,
): number[] {
  const range = PAINTED_VOLUME_DISTANCE_RANGE;
  const isOccupied = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && occupied[y * width + x];
  return occupied.map((_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const inside = isOccupied(x, y);
    let nearest = range + 0.5;
    for (let dy = -range; dy <= range; ++dy) {
      for (let dx = -range; dx <= range; ++dx) {
        if (isOccupied(x + dx, y + dy) !== inside) {
          nearest = Math.min(nearest, Math.hypot(dx, dy));
        }
      }
    }
    const signed = inside ? nearest - 0.5 : 0.5 - nearest;
    const clamped = Math.max(-range, Math.min(range, signed));
    return 0.5 + clamped / (2 * range);
  });
}

/** One z layer of the R8 distance texture as stored, 0..1, x fastest. */
export function readEncodedDistanceLayer(
  gl: GL,
  texture: WebGLTexture,
  width: number,
  height: number,
  layer: number,
): number[] {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTextureLayer(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    texture,
    0,
    layer,
  );
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  return Array.from({ length: width * height }, (_, i) => pixels[i * 4] / 255);
}

/**
 * GL's bilinear filtering of a layer at texel coordinates (x, y), where texel
 * i spans [i, i + 1), with clamp-to-edge.
 */
export function sampleLayerBilinear(
  layer: readonly number[],
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const clampX = (i: number) => Math.max(0, Math.min(width - 1, i));
  const clampY = (i: number) => Math.max(0, Math.min(height - 1, i));
  const u = x - 0.5;
  const v = y - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const at = (i: number, j: number) => layer[clampY(j) * width + clampX(i)];
  return (
    (1 - fx) * (1 - fy) * at(x0, y0) +
    fx * (1 - fy) * at(x0 + 1, y0) +
    (1 - fx) * fy * at(x0, y0 + 1) +
    fx * fy * at(x0 + 1, y0 + 1)
  );
}

/**
 * GL's trilinear filtering of the whole R8 distance texture (layers as
 * `readEncodedDistanceLayer` returns them) at texel coordinates `point`, with
 * clamp-to-edge.
 */
export function sampleVolumeTrilinear(
  layers: readonly (readonly number[])[],
  width: number,
  height: number,
  point: readonly [number, number, number],
): number {
  const [x, y, z] = point;
  const clampLayer = (i: number) => Math.max(0, Math.min(layers.length - 1, i));
  const w = z - 0.5;
  const lowerLayer = Math.floor(w);
  const fraction = w - lowerLayer;
  const lower = sampleLayerBilinear(
    layers[clampLayer(lowerLayer)],
    width,
    height,
    x,
    y,
  );
  const upper = sampleLayerBilinear(
    layers[clampLayer(lowerLayer + 1)],
    width,
    height,
    x,
    y,
  );
  return (1 - fraction) * lower + fraction * upper;
}
