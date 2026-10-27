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
 * Real-WebGL2 checks for the painted-volume textures: what lands in GPU memory
 * after an upload is only observable by reading it back, so each test reads
 * the texture through a framebuffer attachment.
 */

import { describe, expect, it } from "vitest";

import {
  PaintedVolumePaletteTexture,
  PaintedVolumeTexture,
} from "#src/editing/painted_volume/painted_volume_texture.js";
import type { GL } from "#src/webgl/context.js";
import { webglTest } from "#src/webgl/testing.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";

type Triple = readonly [number, number, number];

const SIZE: Triple = [4, 3, 2];

/** Read one z layer of an R8UI 3-D texture, row-major, x fastest. */
function readClassLayer(
  gl: GL,
  texture: WebGLTexture,
  size: Triple,
  layer: number,
): number[] {
  const [width, height] = size;
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTextureLayer(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    texture,
    0,
    layer,
  );
  const pixels = new Uint32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  return Array.from({ length: width * height }, (_, i) => pixels[i * 4]);
}

function readPaletteRow(gl: GL, texture: WebGLTexture, width: number) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  const pixels = new Uint8Array(width * 4);
  gl.readPixels(0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  return pixels;
}

describe("PaintedVolumeTexture", () => {
  it("allocates a zeroed texture of the requested size", () => {
    webglTest((gl) => {
      const texture = new PaintedVolumeTexture(gl, new FakeLogger());
      try {
        expect(texture.allocate(SIZE)).toBe(true);
        expect(texture.size).toEqual(SIZE);
        expect(readClassLayer(gl, texture.texture!, SIZE, 1)).toEqual(
          new Array(12).fill(0),
        );
        expect(gl.getError()).toBe(gl.NO_ERROR);
      } finally {
        texture.dispose();
      }
    });
  });

  it("uploads exactly the given texel box", () => {
    webglTest((gl) => {
      const texture = new PaintedVolumeTexture(gl, new FakeLogger());
      try {
        texture.allocate(SIZE);
        // 3 × 2 × 1 box at (1, 1, 1); odd width exercises unpack alignment.
        texture.uploadBox(
          { x0: 1, y0: 1, z0: 1, x1: 3, y1: 2, z1: 1 },
          Uint8Array.from([1, 2, 3, 4, 5, 6]),
        );
        expect(readClassLayer(gl, texture.texture!, SIZE, 0)).toEqual(
          new Array(12).fill(0),
        );
        expect(readClassLayer(gl, texture.texture!, SIZE, 1)).toEqual([
          0, 0, 0, 0, 0, 1, 2, 3, 0, 4, 5, 6,
        ]);
        expect(gl.getError()).toBe(gl.NO_ERROR);
      } finally {
        texture.dispose();
      }
    });
  });

  it("restores the unpack alignment it changes", () => {
    webglTest((gl) => {
      const texture = new PaintedVolumeTexture(gl, new FakeLogger());
      try {
        texture.allocate(SIZE);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8);
        texture.uploadBox(
          { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 },
          Uint8Array.from([7]),
        );
        expect(gl.getParameter(gl.UNPACK_ALIGNMENT)).toBe(8);
      } finally {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        texture.dispose();
      }
    });
  });

  it("clears back to zero at the same size", () => {
    webglTest((gl) => {
      const texture = new PaintedVolumeTexture(gl, new FakeLogger());
      try {
        texture.allocate(SIZE);
        texture.uploadBox(
          { x0: 0, y0: 0, z0: 0, x1: 3, y1: 2, z1: 1 },
          new Uint8Array(24).fill(9),
        );
        texture.clear();
        expect(texture.size).toEqual(SIZE);
        expect(readClassLayer(gl, texture.texture!, SIZE, 0)).toEqual(
          new Array(12).fill(0),
        );
        expect(gl.getError()).toBe(gl.NO_ERROR);
      } finally {
        texture.dispose();
      }
    });
  });

  it("reports and logs a failed allocation without leaving a GL error", () => {
    webglTest((gl) => {
      const logger = new FakeLogger();
      const texture = new PaintedVolumeTexture(gl, logger);
      try {
        const tooLarge = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) * 2;
        expect(texture.allocate([tooLarge, 1, 1])).toBe(false);
        expect(texture.texture).toBeUndefined();
        expect(texture.size).toBeUndefined();
        expect(logger.logs.map((log) => log.level)).toContain("error");
        expect(gl.getError()).toBe(gl.NO_ERROR);
      } finally {
        texture.dispose();
      }
    });
  });

  it("binds to the requested texture unit", () => {
    webglTest((gl) => {
      const texture = new PaintedVolumeTexture(gl, new FakeLogger());
      try {
        texture.allocate(SIZE);
        texture.bind(3);
        gl.activeTexture(gl.TEXTURE3);
        expect(gl.getParameter(gl.TEXTURE_BINDING_3D)).toBe(texture.texture);
      } finally {
        gl.activeTexture(gl.TEXTURE0);
        texture.dispose();
      }
    });
  });
});

describe("PaintedVolumePaletteTexture", () => {
  it("uploads 256 RGBA colours, one texel per class", () => {
    webglTest((gl) => {
      const palette = new PaintedVolumePaletteTexture(gl);
      try {
        const colors = new Uint8Array(256 * 4);
        colors.set([10, 20, 30, 255], 1 * 4);
        colors.set([1, 2, 3, 0], 255 * 4);
        palette.upload(colors);
        const row = readPaletteRow(gl, palette.texture, 256);
        expect(Array.from(row.subarray(4, 8))).toEqual([10, 20, 30, 255]);
        expect(Array.from(row.subarray(255 * 4, 256 * 4))).toEqual([
          1, 2, 3, 0,
        ]);
        expect(gl.getError()).toBe(gl.NO_ERROR);
      } finally {
        palette.dispose();
      }
    });
  });
});
