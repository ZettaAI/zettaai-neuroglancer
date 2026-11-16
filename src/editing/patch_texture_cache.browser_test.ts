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
 * `PatchTextureCache` on real WebGL2 (TM-373, PR 6): a new texture starts all
 * zero and receives only the chunk's `paintedBounds`. Each test reads the
 * textures back through a framebuffer and checks them against the CPU chunk.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { PatchTextureCache } from "#src/editing/patch_texture_cache.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import type { GL } from "#src/webgl/context.js";
import { webglTest } from "#src/webgl/testing.js";

const POSITION = [0, 0, 0];
const UNIT_2D = 0;
const UNIT_3D = 1;

type Size = readonly [number, number, number];

/** The texture `bind` left on the unit of the layout's dimensionality. */
function boundTexture(gl: GL, threeD: boolean): WebGLTexture {
  gl.activeTexture(
    WebGL2RenderingContext.TEXTURE0 + (threeD ? UNIT_3D : UNIT_2D),
  );
  return gl.getParameter(
    threeD
      ? WebGL2RenderingContext.TEXTURE_BINDING_3D
      : WebGL2RenderingContext.TEXTURE_BINDING_2D,
  ) as WebGLTexture;
}

/** The texture extent the cache chose (test-only peek at its layout). */
function textureShapeOf(cache: PatchTextureCache): Size {
  const { layout } = cache as unknown as {
    layout: { textureShape: [number, number, number] };
  };
  return layout.textureShape;
}

/**
 * Read an integer texture of extent `shape` back as RGBA uint32 per texel.
 * Every layout the cache makes is row-major in the chunk's flat order, so
 * texel i is voxel i.
 */
function readBack(
  gl: GL,
  texture: WebGLTexture,
  shape: Size,
  threeD: boolean,
): Uint32Array {
  const [width, height, depth] = shape;
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(WebGL2RenderingContext.FRAMEBUFFER, framebuffer);
  const out = new Uint32Array(width * height * depth * 4);
  const layer = new Uint32Array(width * height * 4);
  for (let z = 0; z < depth; z++) {
    if (threeD) {
      gl.framebufferTextureLayer(
        WebGL2RenderingContext.FRAMEBUFFER,
        WebGL2RenderingContext.COLOR_ATTACHMENT0,
        texture,
        0,
        z,
      );
    } else {
      gl.framebufferTexture2D(
        WebGL2RenderingContext.FRAMEBUFFER,
        WebGL2RenderingContext.COLOR_ATTACHMENT0,
        WebGL2RenderingContext.TEXTURE_2D,
        texture,
        0,
      );
    }
    gl.readPixels(
      0,
      0,
      width,
      height,
      WebGL2RenderingContext.RGBA_INTEGER,
      WebGL2RenderingContext.UNSIGNED_INT,
      layer,
    );
    out.set(layer, z * width * height * 4);
  }
  gl.bindFramebuffer(WebGL2RenderingContext.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  return out;
}

/**
 * Bind both textures through `cache`, read them back and count the voxels
 * whose texture state differs from the CPU chunk: a mask bit that differs,
 * or a value that differs where the mask is 1 (the only place it is read).
 */
function mismatchesAfterBind(
  gl: GL,
  cache: PatchTextureCache,
  store: LocalPatchStore,
): number {
  cache.bindPatchValueTextures(gl, UNIT_2D, UNIT_3D, POSITION);
  const threeD = cache.is3D;
  const shape = textureShapeOf(cache);
  const value = readBack(gl, boundTexture(gl, threeD), shape, threeD);
  cache.bindPatchedMaskTextures(gl, UNIT_2D, UNIT_3D, POSITION);
  const mask = readBack(gl, boundTexture(gl, threeD), shape, threeD);
  const chunk = store.source.getChunk(POSITION)!;
  const data32 = new Uint32Array(
    chunk.data.buffer,
    chunk.data.byteOffset,
    chunk.data.length * 2,
  );
  let mismatches = 0;
  for (let i = 0; i < chunk.patched.length; i++) {
    const bit = chunk.patched[i];
    if (mask[i * 4] !== bit) {
      mismatches++;
    } else if (
      bit === 1 &&
      (value[i * 4] !== data32[2 * i] || value[i * 4 + 1] !== data32[2 * i + 1])
    ) {
      mismatches++;
    }
  }
  return mismatches;
}

function uploadedBytes(): number {
  return paintProfiler.snapshot().counters["gpu.uploadBytes"] ?? 0;
}

describe("PatchTextureCache — a new texture uploads only paintedBounds", () => {
  beforeEach(() => {
    paintProfiler.enabled = true;
    paintProfiler.resetWindow();
  });
  afterEach(() => {
    paintProfiler.resetWindow();
    paintProfiler.enabled = false;
  });

  // Chunk shapes the shared TextureLayout maps one axis per texture axis
  // ("separable"); smaller chunks are packed flat and keep the full upload.
  for (const size of [
    [128, 128, 128],
    [256, 128, 1],
  ] as const) {
    const layout = size[2] > 1 ? "3D" : "2D";
    const lastZ = size[2] - 1;

    it(`${layout}: uploads the painted box and shows exactly what is painted`, () => {
      webglTest((gl) => {
        const store = new LocalPatchStore();
        const cache = new PatchTextureCache(store);
        store.source.writeVoxel(POSITION, size, 2, 1, 0, 0x1_0000_0007n);
        store.source.writeVoxel(POSITION, size, 4, 3, lastZ, 0n); // erase is patched
        const paintedVoxels = 3 * 3 * size[2]; // x 2..4, y 1..3, z 0..last

        expect(mismatchesAfterBind(gl, cache, store)).toBe(0);
        expect(cache.is3D).toBe(size[2] > 1);
        expect(uploadedBytes()).toBe(paintedVoxels * (8 + 1));
        cache.dispose();
      });
    });

    it(`${layout}: a chunk with nothing painted uploads nothing`, () => {
      webglTest((gl) => {
        const store = new LocalPatchStore();
        const cache = new PatchTextureCache(store);
        store.source.getOrCreateChunk(POSITION, size);

        expect(mismatchesAfterBind(gl, cache, store)).toBe(0);
        expect(uploadedBytes()).toBe(0);
        cache.dispose();
      });
    });

    it(`${layout}: a second texture shows everything painted so far`, () => {
      webglTest((gl) => {
        const store = new LocalPatchStore();
        const first = new PatchTextureCache(store);
        store.source.writeVoxel(POSITION, size, 0, 0, 0, 5n);
        expect(mismatchesAfterBind(gl, first, store)).toBe(0); // consumes it
        store.source.writeVoxel(POSITION, size, 7, 5, lastZ, 9n);
        expect(mismatchesAfterBind(gl, first, store)).toBe(0); // a sub-box upload

        // A new texture (another cache, as in a second GL context) has only
        // `paintedBounds` to go by: both voxels must show.
        const second = new PatchTextureCache(store);
        expect(mismatchesAfterBind(gl, second, store)).toBe(0);
        first.dispose();
        second.dispose();
      });
    });

    it(`${layout}: a chunk re-created over a live texture uploads its own bounds and drops the old patch`, () => {
      webglTest((gl) => {
        const store = new LocalPatchStore();
        const cache = new PatchTextureCache(store);
        store.source.writeVoxel(POSITION, size, 9, 9, lastZ, 4n);
        expect(mismatchesAfterBind(gl, cache, store)).toBe(0);
        // Dropped (e.g. a discarded edit) and painted again elsewhere: the
        // texture is still there and still holds the old voxel.
        store.clearChunk(POSITION);
        store.source.writeVoxel(POSITION, size, 1, 2, 0, 6n);
        paintProfiler.resetWindow();

        expect(mismatchesAfterBind(gl, cache, store)).toBe(0);
        expect(uploadedBytes()).toBe(1 * (8 + 1));
        cache.dispose();
      });
    });

    it(`${layout}: writeFullChunk uploads the whole chunk`, () => {
      webglTest((gl) => {
        const store = new LocalPatchStore();
        const cache = new PatchTextureCache(store);
        const voxels = size[0] * size[1] * size[2];
        const data = BigUint64Array.from({ length: voxels }, (_, i) =>
          BigInt(i * 3),
        );
        const patched = Uint8Array.from({ length: voxels }, (_, i) => i % 2);
        store.source.writeFullChunk(POSITION, size, data, patched);

        expect(mismatchesAfterBind(gl, cache, store)).toBe(0);
        expect(uploadedBytes()).toBe(voxels * (8 + 1));
        cache.dispose();
      });
    });
  }

  it("a packed (non-separable) chunk keeps the full upload", () => {
    webglTest((gl) => {
      const size = [8, 6, 3] as const;
      const store = new LocalPatchStore();
      const cache = new PatchTextureCache(store);
      store.source.writeVoxel(POSITION, size, 1, 1, 1, 3n);

      expect(mismatchesAfterBind(gl, cache, store)).toBe(0);
      expect(uploadedBytes()).toBe(8 * 6 * 3 * (8 + 1));
      cache.dispose();
    });
  });
});
