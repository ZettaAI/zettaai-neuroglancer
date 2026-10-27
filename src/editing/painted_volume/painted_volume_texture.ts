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
 * @file GPU storage of the painted volume: the R8UI 3-D class texture, its R8
 * coverage twin, and the 256 × 1 RGBA8 palette the shader looks classes up in.
 *
 * The coverage texture holds 255 where the class texture is non-zero and 0
 * elsewhere, and is sampled with linear filtering: the shader finds the smooth
 * surface where the interpolated coverage crosses one half, and lights it by
 * the coverage gradient. Both textures are immutable storage (`texStorage3D`),
 * written box by box together.
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
const FULL_COVERAGE = 255;

export class PaintedVolumeTexture {
  private texture_: WebGLTexture | undefined;
  private coverage_: WebGLTexture | undefined;
  private size_: Triple | undefined;
  private coverageScratch = new Uint8Array(0);

  constructor(
    private readonly gl: GL,
    private readonly logger: Logger,
  ) {}

  /** The class texture, or `undefined` before allocation or after a failure. */
  get texture(): WebGLTexture | undefined {
    return this.texture_;
  }

  /** The linearly filtered coverage texture, allocated with the class texture. */
  get coverageTexture(): WebGLTexture | undefined {
    return this.coverage_;
  }

  get size(): Triple | undefined {
    return this.size_;
  }

  /** (Re)allocate zeroed storage of `size` texels; `false` when the GPU refused. */
  allocate(size: Triple): boolean {
    this.release();
    const { gl } = this;
    drainErrors(gl);
    const texture = createVolumeStorage(gl, gl.R8UI, gl.NEAREST, size);
    const coverage = createVolumeStorage(gl, gl.R8, gl.LINEAR, size);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      gl.deleteTexture(coverage);
      this.logger.error(
        "editing",
        "3D preview: the GPU could not allocate the painted-volume texture",
        { size: [...size], glError: error },
      );
      return false;
    }
    this.texture_ = texture;
    this.coverage_ = coverage;
    this.size_ = [size[0], size[1], size[2]];
    return true;
  }

  /**
   * Write class `bytes` (x fastest) into the inclusive `texelBox`, and their
   * coverage into the same box of the coverage texture.
   */
  uploadBox(texelBox: TexelBox, bytes: Uint8Array): void {
    if (this.texture_ === undefined || this.coverage_ === undefined) return;
    const { gl } = this;
    const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, TIGHT_UNPACK_ALIGNMENT);
    uploadVolumeBox(gl, this.texture_, texelBox, gl.RED_INTEGER, bytes);
    uploadVolumeBox(
      gl,
      this.coverage_,
      texelBox,
      gl.RED,
      this.coverageOf(bytes),
    );
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

  /** Bind the class texture to texture unit `unit`; leaves that unit active. */
  bind(unit: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, this.texture_ ?? null);
  }

  /** Bind the coverage texture to texture unit `unit`; leaves that unit active. */
  bindCoverage(unit: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, this.coverage_ ?? null);
  }

  dispose(): void {
    this.release();
  }

  /** Coverage bytes of `classBytes`, in a scratch buffer reused across uploads. */
  private coverageOf(classBytes: Uint8Array): Uint8Array {
    const length = classBytes.length;
    const wordCount = length >>> 2;
    if (this.coverageScratch.length < wordCount * 4 + 4) {
      this.coverageScratch = new Uint8Array(wordCount * 4 + 4);
    }
    const coverage = this.coverageScratch.subarray(0, length);
    let firstTailByte = 0;
    if (classBytes.byteOffset % 4 === 0) {
      writeCoverageWords(
        new Uint32Array(classBytes.buffer, classBytes.byteOffset, wordCount),
        new Uint32Array(this.coverageScratch.buffer, 0, wordCount),
      );
      firstTailByte = wordCount * 4;
    }
    for (let i = firstTailByte; i < length; ++i) {
      coverage[i] = classBytes[i] === 0 ? 0 : FULL_COVERAGE;
    }
    return coverage;
  }

  private release(): void {
    if (this.texture_ !== undefined) this.gl.deleteTexture(this.texture_);
    if (this.coverage_ !== undefined) this.gl.deleteTexture(this.coverage_);
    this.texture_ = undefined;
    this.coverage_ = undefined;
    this.size_ = undefined;
  }
}

const LOW_SEVEN_BITS = 0x7f7f7f7f;
const HIGH_BITS = 0x80808080;

/**
 * Hot path (`7.preview.upload`: a 1025-voxel brush went from 1.6 to 9.8 ms
 * with a per-byte loop): four class bytes per step, no branches. A byte's high
 * bit ends up set exactly when the byte is non-zero; it is then spread to 0xff.
 */
function writeCoverageWords(
  classWords: Uint32Array,
  coverageWords: Uint32Array,
) {
  for (let i = 0; i < classWords.length; ++i) {
    const word = classWords[i];
    const nonZeroHighBits =
      (((word & LOW_SEVEN_BITS) + LOW_SEVEN_BITS) | word) & HIGH_BITS;
    coverageWords[i] = (nonZeroHighBits >>> 7) * 0xff;
  }
}

/** Immutable single-level 3-D storage of `size` texels, edge-clamped. */
function createVolumeStorage(
  gl: GL,
  internalFormat: number,
  filter: number,
  size: Triple,
): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
  for (const wrap of [
    gl.TEXTURE_WRAP_S,
    gl.TEXTURE_WRAP_T,
    gl.TEXTURE_WRAP_R,
  ]) {
    gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
  }
  gl.texStorage3D(gl.TEXTURE_3D, 1, internalFormat, size[0], size[1], size[2]);
  gl.bindTexture(gl.TEXTURE_3D, null);
  return texture;
}

/** One-byte-per-texel `bytes` (x fastest) into the inclusive `texelBox`. */
function uploadVolumeBox(
  gl: GL,
  texture: WebGLTexture,
  texelBox: TexelBox,
  format: number,
  bytes: Uint8Array,
): void {
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texSubImage3D(
    gl.TEXTURE_3D,
    0,
    texelBox.x0,
    texelBox.y0,
    texelBox.z0,
    texelBox.x1 - texelBox.x0 + 1,
    texelBox.y1 - texelBox.y0 + 1,
    texelBox.z1 - texelBox.z0 + 1,
    format,
    gl.UNSIGNED_BYTE,
    bytes,
  );
  gl.bindTexture(gl.TEXTURE_3D, null);
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
