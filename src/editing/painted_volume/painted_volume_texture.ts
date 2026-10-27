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
 * @file GPU storage of the painted volume: the R8UI 3-D class texture and the
 * 256 × 1 RGBA8 palette the shader looks classes up in.
 *
 * The class texture is immutable storage (`texStorage3D`), written box by box.
 * It lives outside NG's chunk manager, so it can neither be evicted nor be
 * counted against `gpuMemoryLimit`; a failed allocation (out of memory, or a
 * size past `MAX_3D_TEXTURE_SIZE`) leaves it disabled and logged rather than
 * throwing into the render loop.
 */

import type { Logger } from "@zettaai/edit-session";

import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import type { GL } from "#src/webgl/context.js";

type Triple = readonly [number, number, number];

/** Class rows are one byte per texel and need not be 4-byte aligned. */
const TIGHT_UNPACK_ALIGNMENT = 1;
const PALETTE_WIDTH = 256;

export class PaintedVolumeTexture {
  private texture_: WebGLTexture | undefined;
  private size_: Triple | undefined;

  constructor(
    private readonly gl: GL,
    private readonly logger: Logger,
  ) {}

  /** The class texture, or `undefined` before allocation or after a failure. */
  get texture(): WebGLTexture | undefined {
    return this.texture_;
  }

  get size(): Triple | undefined {
    return this.size_;
  }

  /** (Re)allocate zeroed storage of `size` texels; `false` when the GPU refused. */
  allocate(size: Triple): boolean {
    this.release();
    const { gl } = this;
    drainErrors(gl);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    for (const wrap of [
      gl.TEXTURE_WRAP_S,
      gl.TEXTURE_WRAP_T,
      gl.TEXTURE_WRAP_R,
    ]) {
      gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
    }
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8UI, size[0], size[1], size[2]);
    gl.bindTexture(gl.TEXTURE_3D, null);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      this.logger.error(
        "editing",
        "3D preview: the GPU could not allocate the painted-volume texture",
        { size: [...size], glError: error },
      );
      return false;
    }
    this.texture_ = texture;
    this.size_ = [size[0], size[1], size[2]];
    return true;
  }

  /** Write `bytes` (x fastest) into the inclusive `texelBox`. */
  uploadBox(texelBox: TexelBox, bytes: Uint8Array): void {
    if (this.texture_ === undefined) return;
    const { gl } = this;
    const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, TIGHT_UNPACK_ALIGNMENT);
    gl.bindTexture(gl.TEXTURE_3D, this.texture_);
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      texelBox.x0,
      texelBox.y0,
      texelBox.z0,
      texelBox.x1 - texelBox.x0 + 1,
      texelBox.y1 - texelBox.y0 + 1,
      texelBox.z1 - texelBox.z0 + 1,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      bytes,
    );
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
  }

  /**
   * Zero every texel by recreating the storage — immutable storage cannot be
   * redefined, and this avoids a texture-sized buffer of zeros.
   */
  clear(): void {
    const size = this.size_;
    if (size !== undefined) this.allocate(size);
  }

  /** Bind to texture unit `unit`; leaves that unit active. */
  bind(unit: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, this.texture_ ?? null);
  }

  dispose(): void {
    this.release();
  }

  private release(): void {
    if (this.texture_ !== undefined) this.gl.deleteTexture(this.texture_);
    this.texture_ = undefined;
    this.size_ = undefined;
  }
}

export class PaintedVolumePaletteTexture {
  readonly texture: WebGLTexture;

  constructor(private readonly gl: GL) {
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, PALETTE_WIDTH, 1);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Upload `PaintedVolumeSegmentPalette.colors` (RGBA8 per class). */
  upload(colors: Uint8Array): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      PALETTE_WIDTH,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      colors,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Bind to texture unit `unit`; leaves that unit active. */
  bind(unit: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}

/** GL keeps at most one pending error per kind; there are fewer than this. */
const MAX_PENDING_GL_ERRORS = 16;

/** Discard errors left by earlier calls so the next `getError` is ours. */
function drainErrors(gl: GL): void {
  for (let i = 0; i < MAX_PENDING_GL_ERRORS; ++i) {
    if (gl.getError() === gl.NO_ERROR) return;
  }
}
