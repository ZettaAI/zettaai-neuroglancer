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
 * @file Which 8³ blocks of the painted volume the preview's ray can skip.
 *
 * The march samples the linearly filtered distance field, and an encoded
 * distance is at or above one half only on an occupied texel
 * (`painted_volume_distance_field.ts`). A point in texel cell `c` interpolates
 * texels `c - 1 .. c + 1`, so a block whose cells and their one-texel rim hold
 * no occupied texel cannot contain the surface, nor the inside of it: every
 * sample the march takes there reads below one half. The ray crosses such a
 * block in one step instead of one texel at a time, and draws exactly what it
 * drew before.
 *
 * A block's flag is 1 when the block grown by that one-texel rim holds an
 * occupied texel.
 */

import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";

type Triple = readonly [number, number, number];

/** Texels per block edge; also the shader's `BLOCK_SIZE`. */
export const PAINTED_VOLUME_BLOCK_SIZE = 8;

/** Flag bytes of a box of blocks, x fastest. */
export interface PaintedVolumeBlockFlags {
  readonly blockBox: TexelBox;
  readonly bytes: Uint8Array;
}

/** Answers whether any texel of an inclusive box is occupied. */
export interface OccupiedTexelQuery {
  anyOccupiedIn(texelBox: TexelBox): boolean;
}

/** Number of blocks covering `textureSize` along each axis. */
export function paintedVolumeBlockGridSize(
  textureSize: Triple,
): [number, number, number] {
  return [
    Math.ceil(textureSize[0] / PAINTED_VOLUME_BLOCK_SIZE),
    Math.ceil(textureSize[1] / PAINTED_VOLUME_BLOCK_SIZE),
    Math.ceil(textureSize[2] / PAINTED_VOLUME_BLOCK_SIZE),
  ];
}

export class PaintedVolumeOccupiedBlocks {
  readonly gridSize: [number, number, number];
  private output = new Uint8Array(0);

  constructor(private readonly textureSize: Triple) {
    this.gridSize = paintedVolumeBlockGridSize(textureSize);
  }

  /** True when this grid covers a texture of `size` texels. */
  hasTextureSize(size: Triple): boolean {
    return size.every((extent, axis) => extent === this.textureSize[axis]);
  }

  /**
   * The flags a write to `texelBox` can change, re-read from `texels`: every
   * block whose rim-grown texels overlap the box. The bytes are reused by the
   * next call.
   */
  flagsAfterWrite(
    texelBox: TexelBox,
    texels: OccupiedTexelQuery,
  ): PaintedVolumeBlockFlags {
    const blockBox = this.blocksOf(this.grownByRim(texelBox));
    const width = blockBox.x1 - blockBox.x0 + 1;
    const height = blockBox.y1 - blockBox.y0 + 1;
    const depth = blockBox.z1 - blockBox.z0 + 1;
    const bytes = this.outputOfLength(width * height * depth);
    let target = 0;
    for (let blockZ = blockBox.z0; blockZ <= blockBox.z1; ++blockZ) {
      for (let blockY = blockBox.y0; blockY <= blockBox.y1; ++blockY) {
        for (let blockX = blockBox.x0; blockX <= blockBox.x1; ++blockX) {
          const sampled = this.grownByRim(
            this.texelsOfBlock(blockX, blockY, blockZ),
          );
          bytes[target++] = texels.anyOccupiedIn(sampled) ? 1 : 0;
        }
      }
    }
    return { blockBox, bytes };
  }

  /** Inclusive box of the blocks holding `texelBox`. */
  private blocksOf(texelBox: TexelBox): TexelBox {
    const size = PAINTED_VOLUME_BLOCK_SIZE;
    return {
      x0: Math.floor(texelBox.x0 / size),
      y0: Math.floor(texelBox.y0 / size),
      z0: Math.floor(texelBox.z0 / size),
      x1: Math.floor(texelBox.x1 / size),
      y1: Math.floor(texelBox.y1 / size),
      z1: Math.floor(texelBox.z1 / size),
    };
  }

  /** `texelBox` grown by the one texel linear filtering reaches, clamped. */
  private grownByRim(texelBox: TexelBox): TexelBox {
    const [textureX, textureY, textureZ] = this.textureSize;
    return {
      x0: Math.max(0, texelBox.x0 - 1),
      y0: Math.max(0, texelBox.y0 - 1),
      z0: Math.max(0, texelBox.z0 - 1),
      x1: Math.min(textureX - 1, texelBox.x1 + 1),
      y1: Math.min(textureY - 1, texelBox.y1 + 1),
      z1: Math.min(textureZ - 1, texelBox.z1 + 1),
    };
  }

  /** Inclusive texel box of one block, clamped to the texture. */
  private texelsOfBlock(
    blockX: number,
    blockY: number,
    blockZ: number,
  ): TexelBox {
    const size = PAINTED_VOLUME_BLOCK_SIZE;
    const [textureX, textureY, textureZ] = this.textureSize;
    return {
      x0: blockX * size,
      y0: blockY * size,
      z0: blockZ * size,
      x1: Math.min(textureX - 1, blockX * size + size - 1),
      y1: Math.min(textureY - 1, blockY * size + size - 1),
      z1: Math.min(textureZ - 1, blockZ * size + size - 1),
    };
  }

  private outputOfLength(length: number): Uint8Array {
    if (this.output.length < length) this.output = new Uint8Array(length);
    return this.output.subarray(0, length);
  }
}
