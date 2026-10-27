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
 * Real-WebGL2 checks for the painted-volume ray-march. Everything that can go
 * wrong lives in GLSL — the ray setup, the DDA start, the depth written — so
 * each test renders through the real shader into a framebuffer shaped like the
 * perspective panel's (colour + z + pick, with a depth buffer) and reads the
 * pixels back.
 *
 * Units: the texel → display matrix scales each texel by `PIXELS_PER_TEXEL`
 * display units, and orthographic views map one display unit to one pixel, so
 * texel edges land on whole pixels.
 */

import { describe, expect, it } from "vitest";

import type {
  PaintedVolumeCursorFootprint,
  PaintedVolumeRenderSource,
  PaintedVolumeView,
} from "#src/editing/painted_volume/painted_volume_render_layer.js";
import {
  buildPaintedVolumeShader,
  PaintedVolumeRenderer,
  PaintedVolumeRenderLayer,
} from "#src/editing/painted_volume/painted_volume_render_layer.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import {
  PaintedVolumePaletteTexture,
  PaintedVolumeTexture,
} from "#src/editing/painted_volume/painted_volume_texture.js";
import { brushRadiusSquared } from "#src/editing/tool_runtimes/brush_disk_footprint.js";
import { perspectivePanelEmit } from "#src/perspective_view/panel.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { mat4, vec3 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import {
  DepthStencilRenderbuffer,
  FramebufferConfiguration,
  TextureBuffer,
} from "#src/webgl/offscreen.js";
import { webglTest } from "#src/webgl/testing.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";

type Triple = readonly [number, number, number];

const FRAMEBUFFER_SIZE = 64;
const CENTER_PIXEL = FRAMEBUFFER_SIZE / 2;
const PIXELS_PER_TEXEL = 8;
const CUBE_TEXTURE: Triple = [8, 8, 8];

const CLASS_A = 1;
const CLASS_B = 2;
const COLOR_A = [200, 40, 40, 255];
const COLOR_B = [40, 200, 40, 255];
const BACKGROUND = [0, 0, 0, 0];

/** Ambient-only lighting reproduces the palette colour exactly. */
const FLAT_LIGHT = {
  lightDirection: [0, 0, 1],
  ambientLighting: 1,
  directionalLighting: 0,
};

interface PlacedTexel {
  readonly texel: Triple;
  readonly segmentClass: number;
}

interface Scene {
  readonly textureSize?: Triple;
  readonly texels: readonly PlacedTexel[];
  /** Defaults to the whole texture. */
  readonly occupiedBox?: TexelBox;
  readonly transparentClasses?: readonly number[];
  readonly cursorFootprint?: PaintedVolumeCursorFootprint;
  /** Display units per texel along x, y, z. */
  readonly scale?: Triple;
}

interface Rendered {
  /** RGBA8, row-major from the bottom row. */
  readonly color: Uint8Array;
  /** The panel's Z attachment, red channel per pixel. */
  readonly z: Float32Array;
}

function wholeTexture(size: Triple): TexelBox {
  return {
    x0: 0,
    y0: 0,
    z0: 0,
    x1: size[0] - 1,
    y1: size[1] - 1,
    z1: size[2] - 1,
  };
}

function slab(axis: number, index: number, segmentClass: number) {
  const texels: PlacedTexel[] = [];
  for (let i = 0; i < CUBE_TEXTURE[0]; ++i) {
    for (let j = 0; j < CUBE_TEXTURE[1]; ++j) {
      const texel = [i, j];
      texel.splice(axis, 0, index);
      texels.push({ texel: texel as unknown as Triple, segmentClass });
    }
  }
  return texels;
}

function paletteColors(transparentClasses: readonly number[] = []) {
  const colors = new Uint8Array(256 * 4);
  colors.set(COLOR_A, CLASS_A * 4);
  colors.set(COLOR_B, CLASS_B * 4);
  for (const segmentClass of transparentClasses)
    colors[segmentClass * 4 + 3] = 0;
  return colors;
}

/** Build GPU resources for `scene`, run `body`, and free them. */
function withSource(
  gl: GL,
  scene: Scene,
  body: (source: PaintedVolumeRenderSource) => void,
): void {
  const textureSize = scene.textureSize ?? CUBE_TEXTURE;
  const texture = new PaintedVolumeTexture(gl, new FakeLogger());
  const palette = new PaintedVolumePaletteTexture(gl);
  try {
    expect(texture.allocate(textureSize)).toBe(true);
    for (const { texel, segmentClass } of scene.texels) {
      const [x, y, z] = texel;
      texture.uploadBox(
        { x0: x, y0: y, z0: z, x1: x, y1: y, z1: z },
        Uint8Array.of(segmentClass),
      );
    }
    palette.upload(paletteColors(scene.transparentClasses));
    const scale = scene.scale ?? [
      PIXELS_PER_TEXEL,
      PIXELS_PER_TEXEL,
      PIXELS_PER_TEXEL,
    ];
    body({
      texture,
      palette,
      extent: {
        textureOrigin: [0, 0, 0],
        factor: [1, 1, 1],
        textureSize: [...textureSize],
      },
      texelToDisplay: mat4.fromScaling(
        mat4.create(),
        vec3.fromValues(...scale),
      ),
      occupiedBox: scene.occupiedBox ?? wholeTexture(textureSize),
      cursorFootprint: scene.cursorFootprint,
    });
  } finally {
    palette.dispose();
    texture.dispose();
  }
}

/** Render through `draw` into a panel-shaped framebuffer and read it back. */
function renderPanel(
  gl: GL,
  draw: () => void,
  options: { clearDepth?: number } = {},
): Rendered {
  const framebuffer = new FramebufferConfiguration(gl, {
    colorBuffers: [
      new TextureBuffer(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
      new TextureBuffer(gl, gl.R32F, gl.RED, gl.FLOAT),
      new TextureBuffer(gl, gl.R32F, gl.RED, gl.FLOAT),
    ],
    depthBuffer: new DepthStencilRenderbuffer(gl),
  });
  const pixelCount = FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE;
  const color = new Uint8Array(pixelCount * 4);
  const zRgba = new Float32Array(pixelCount * 4);
  try {
    framebuffer.bind(FRAMEBUFFER_SIZE, FRAMEBUFFER_SIZE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(options.clearDepth ?? 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    draw();
    gl.disable(gl.DEPTH_TEST);
    gl.clearDepth(1);
    framebuffer.bindSingle(0);
    gl.readPixels(
      0,
      0,
      FRAMEBUFFER_SIZE,
      FRAMEBUFFER_SIZE,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      color,
    );
    framebuffer.bindSingle(1);
    gl.readPixels(
      0,
      0,
      FRAMEBUFFER_SIZE,
      FRAMEBUFFER_SIZE,
      gl.RGBA,
      gl.FLOAT,
      zRgba,
    );
    expect(gl.getError()).toBe(gl.NO_ERROR);
  } finally {
    framebuffer.unbind();
    framebuffer.dispose();
  }
  const z = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; ++i) z[i] = zRgba[i * 4];
  return { color, z };
}

function render(
  gl: GL,
  source: PaintedVolumeRenderSource,
  viewProjectionMat: mat4,
  options: { clearDepth?: number; light?: typeof FLAT_LIGHT } = {},
): Rendered {
  const renderer = new PaintedVolumeRenderer(gl);
  const view: PaintedVolumeView = {
    viewProjectionMat,
    ...(options.light ?? FLAT_LIGHT),
  };
  try {
    return renderPanel(gl, () => renderer.draw(source, view), options);
  } finally {
    renderer.dispose();
  }
}

function pixel(rendered: Rendered, x: number, y: number): number[] {
  const offset = (y * FRAMEBUFFER_SIZE + x) * 4;
  return Array.from(rendered.color.subarray(offset, offset + 4));
}

function zAt(rendered: Rendered, x: number, y: number): number {
  return rendered.z[y * FRAMEBUFFER_SIZE + x];
}

/** Pixel in the middle of a texel, for views where display = texel × 8 px. */
function texelPixel(texel: number): number {
  return texel * PIXELS_PER_TEXEL + PIXELS_PER_TEXEL / 2;
}

function countPixels(rendered: Rendered, rgba: readonly number[]): number {
  let count = 0;
  for (let i = 0; i < FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE; ++i) {
    const offset = i * 4;
    if (rgba.every((channel, k) => rendered.color[offset + k] === channel)) {
      ++count;
    }
  }
  return count;
}

/**
 * Orthographic view from `eye` toward `target`, one display unit per pixel,
 * centred on `target`.
 */
function orthographicView(eye: Triple, target: Triple, up: Triple): mat4 {
  const half = FRAMEBUFFER_SIZE / 2;
  const projection = mat4.ortho(
    mat4.create(),
    -half,
    half,
    -half,
    half,
    1,
    4000,
  );
  return viewProjection(projection, eye, target, up);
}

function perspectiveView(
  eye: Triple,
  target: Triple,
  up: Triple,
  near: number,
  far: number,
): mat4 {
  const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, near, far);
  return viewProjection(projection, eye, target, up);
}

function viewProjection(
  projection: mat4,
  eye: Triple,
  target: Triple,
  up: Triple,
) {
  const view = mat4.lookAt(
    mat4.create(),
    vec3.fromValues(...eye),
    vec3.fromValues(...target),
    vec3.fromValues(...up),
  );
  return mat4.multiply(mat4.create(), projection, view);
}

/** Looking down −z at the cube texture, the whole 64 × 64 display square in view. */
const VIEW_DOWN_Z = orthographicView([32, 32, 1000], [32, 32, 0], [0, 1, 0]);
const Y_UP: Triple = [0, 1, 0];
const Z_UP: Triple = [0, 0, 1];

describe("painted-volume shader", () => {
  it("compiles and links against the panel emitter", () => {
    webglTest((gl) => {
      const shader = buildPaintedVolumeShader(gl);
      try {
        for (const uniform of [
          "uModelViewProjection",
          "uInvModelViewProjection",
          "uBoxLo",
          "uBoxHi",
          "uMaxSteps",
          "uCursorActive",
        ]) {
          expect(shader.uniform(uniform), uniform).not.toBeNull();
        }
      } finally {
        shader.dispose();
      }
    });
  });
});

describe("painted-volume ray march", () => {
  it("draws a single texel in its palette colour, perspective view", () => {
    webglTest((gl) => {
      withSource(
        gl,
        { texels: [{ texel: [4, 4, 3], segmentClass: CLASS_A }] },
        (source) => {
          const rendered = render(
            gl,
            source,
            perspectiveView([32, 32, 200], [32, 32, 0], Y_UP, 1, 1000),
          );
          expect(pixel(rendered, CENTER_PIXEL, CENTER_PIXEL)).toEqual(COLOR_A);
          expect(pixel(rendered, 0, 0)).toEqual(BACKGROUND);
        },
      );
    });
  });

  it("puts the texel in the same place under an orthographic view", () => {
    webglTest((gl) => {
      withSource(
        gl,
        { texels: [{ texel: [4, 4, 3], segmentClass: CLASS_A }] },
        (source) => {
          const rendered = render(gl, source, VIEW_DOWN_Z);
          expect(pixel(rendered, CENTER_PIXEL, CENTER_PIXEL)).toEqual(COLOR_A);
          // Exactly the texel's 8 × 8 pixels, no more.
          expect(countPixels(rendered, COLOR_A)).toBe(64);
          expect(pixel(rendered, 31, 32)).toEqual(BACKGROUND);
          expect(pixel(rendered, 40, 32)).toEqual(BACKGROUND);
        },
      );
    });
  });

  it("is hidden behind nearer depth already in the buffer", () => {
    webglTest((gl) => {
      withSource(
        gl,
        { texels: [{ texel: [4, 4, 3], segmentClass: CLASS_A }] },
        (source) => {
          const rendered = render(gl, source, VIEW_DOWN_Z, { clearDepth: 0 });
          expect(pixel(rendered, CENTER_PIXEL, CENTER_PIXEL)).toEqual(
            BACKGROUND,
          );
        },
      );
    });
  });

  it("sees texels ahead when the camera is inside the volume", () => {
    webglTest((gl) => {
      withSource(
        gl,
        { texels: [{ texel: [4, 4, 1], segmentClass: CLASS_A }] },
        (source) => {
          // Eye at texel (4.5, 4.5, 7.5), looking down −z.
          const rendered = render(
            gl,
            source,
            perspectiveView([36, 36, 60], [36, 36, 0], Y_UP, 0.1, 1000),
          );
          expect(pixel(rendered, CENTER_PIXEL, CENTER_PIXEL)).toEqual(COLOR_A);
        },
      );
    });
  });

  it("stretches an anisotropic texel by its display scale", () => {
    webglTest((gl) => {
      // Texels 4 × 4 × 40 display units; seen from +x, screen x is display y
      // and screen y is display z.
      const scene: Scene = {
        textureSize: [8, 8, 1],
        texels: [{ texel: [4, 4, 0], segmentClass: CLASS_A }],
        scale: [4, 4, 40],
      };
      withSource(gl, scene, (source) => {
        const rendered = render(
          gl,
          source,
          orthographicView([1000, 18, 20], [0, 18, 20], Z_UP),
        );
        let wide = 0;
        let tall = 0;
        for (let i = 0; i < FRAMEBUFFER_SIZE; ++i) {
          if (pixel(rendered, i, CENTER_PIXEL)[3] !== 0) ++wide;
          if (pixel(rendered, CENTER_PIXEL, i)[3] !== 0) ++tall;
        }
        expect(wide).toBe(4);
        expect(tall).toBe(40);
      });
    });
  });

  it("writes the hit's depth to out_z, not the proxy face's", () => {
    webglTest((gl) => {
      withSource(
        gl,
        { texels: [{ texel: [4, 4, 3], segmentClass: CLASS_A }] },
        (source) => {
          const rendered = render(gl, source, VIEW_DOWN_Z);
          // The texel's top face is at display z = 4 × 8.
          const hit = vec3.transformMat4(
            vec3.create(),
            vec3.fromValues(CENTER_PIXEL + 0.5, CENTER_PIXEL + 0.5, 32),
            VIEW_DOWN_Z,
          );
          const hitDepth = (hit[2] + 1) / 2;
          expect(zAt(rendered, CENTER_PIXEL, CENTER_PIXEL)).toBeCloseTo(
            1 - hitDepth,
            5,
          );
        },
      );
    });
  });

  it.each([
    ["x", 0, [1000, 32, 32], Z_UP],
    ["y", 1, [32, 1000, 32], Z_UP],
    ["z", 2, [32, 32, 1000], Y_UP],
  ] as const)(
    "shows one-texel layers on both box faces for a ray along %s",
    (_axisName, axis, eye, up) => {
      webglTest((gl) => {
        const view = orthographicView(eye, [32, 32, 32], up);
        for (const layerIndex of [0, CUBE_TEXTURE[axis] - 1]) {
          withSource(
            gl,
            { texels: slab(axis, layerIndex, CLASS_A) },
            (source) => {
              const rendered = render(gl, source, view);
              expect(
                countPixels(rendered, COLOR_A),
                `layer ${layerIndex}`,
              ).toBe(FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE);
            },
          );
        }
      });
    },
  );

  it("does not step over a layer just behind the entry face with a far far plane", () => {
    webglTest((gl) => {
      withSource(
        gl,
        { texels: slab(2, CUBE_TEXTURE[2] - 1, CLASS_A) },
        (source) => {
          const rendered = render(
            gl,
            source,
            perspectiveView([32, 32, 100], [32, 32, 0], Y_UP, 0.01, 1e6),
          );
          expect(pixel(rendered, CENTER_PIXEL, CENTER_PIXEL)).toEqual(COLOR_A);
          expect(pixel(rendered, 10, 50)).toEqual(COLOR_A);
        },
      );
    });
  });

  it("passes through a class whose palette alpha is 0", () => {
    webglTest((gl) => {
      const scene: Scene = {
        texels: [
          { texel: [4, 4, 6], segmentClass: CLASS_A },
          { texel: [4, 4, 2], segmentClass: CLASS_B },
        ],
        transparentClasses: [CLASS_A],
      };
      withSource(gl, scene, (source) => {
        const rendered = render(gl, source, VIEW_DOWN_Z);
        expect(pixel(rendered, texelPixel(4), texelPixel(4))).toEqual(COLOR_B);
      });
    });
  });

  it("shows texels on the bounds of a clipped occupied box", () => {
    webglTest((gl) => {
      const scene: Scene = {
        texels: [
          { texel: [2, 2, 2], segmentClass: CLASS_A },
          { texel: [5, 5, 5], segmentClass: CLASS_B },
        ],
        occupiedBox: { x0: 2, y0: 2, z0: 2, x1: 5, y1: 5, z1: 5 },
      };
      withSource(gl, scene, (source) => {
        const rendered = render(gl, source, VIEW_DOWN_Z);
        expect(pixel(rendered, texelPixel(2), texelPixel(2))).toEqual(COLOR_A);
        expect(pixel(rendered, texelPixel(5), texelPixel(5))).toEqual(COLOR_B);
        expect(pixel(rendered, texelPixel(1), texelPixel(1))).toEqual(
          BACKGROUND,
        );
      });
    });
  });

  it("lights each face by its normal", () => {
    webglTest((gl) => {
      withSource(
        gl,
        { texels: [{ texel: [4, 4, 3], segmentClass: CLASS_A }] },
        (source) => {
          const facingLight = render(gl, source, VIEW_DOWN_Z, {
            light: {
              lightDirection: [0, 0, -1],
              ambientLighting: 0,
              directionalLighting: 1,
            },
          });
          expect(pixel(facingLight, CENTER_PIXEL, CENTER_PIXEL)).toEqual(
            COLOR_A,
          );
          const grazingLight = render(gl, source, VIEW_DOWN_Z, {
            light: {
              lightDirection: [1, 0, 0],
              ambientLighting: 0,
              directionalLighting: 1,
            },
          });
          expect(pixel(grazingLight, CENTER_PIXEL, CENTER_PIXEL)).toEqual([
            0, 0, 0, 255,
          ]);
        },
      );
    });
  });
});

describe("painted-volume cursor window", () => {
  // Class A fills z = 3, class B fills z = 1 below it; the cursor sits on z = 3.
  const layers = [...slab(2, 3, CLASS_A), ...slab(2, 1, CLASS_B)];
  const cursorFootprint: PaintedVolumeCursorFootprint = {
    anchorVoxel: [4, 4, 3],
    radiusSquared: brushRadiusSquared(1),
  };

  it("skips the cursor's footprint on its own z and draws what is below", () => {
    webglTest((gl) => {
      withSource(gl, { texels: layers, cursorFootprint }, (source) => {
        const rendered = render(gl, source, VIEW_DOWN_Z);
        const under = (x: number, y: number) =>
          pixel(rendered, texelPixel(x), texelPixel(y));
        expect(under(4, 4)).toEqual(COLOR_B);
        expect(under(5, 4)).toEqual(COLOR_B);
        expect(under(4, 3)).toEqual(COLOR_B);
        expect(under(5, 5)).toEqual(COLOR_A);
        expect(under(0, 0)).toEqual(COLOR_A);
      });
    });
  });

  it("draws everything when the cursor is inactive", () => {
    webglTest((gl) => {
      withSource(gl, { texels: layers }, (source) => {
        const rendered = render(gl, source, VIEW_DOWN_Z);
        expect(countPixels(rendered, COLOR_A)).toBe(
          FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE,
        );
      });
    });
  });
});

describe("PaintedVolumeRenderLayer", () => {
  function renderContext(
    emitter: PerspectiveViewRenderContext["emitter"],
    emitColor = true,
  ): PerspectiveViewRenderContext {
    return {
      emitter,
      emitColor,
      projectionParameters: { viewProjectionMat: VIEW_DOWN_Z },
      ...FLAT_LIGHT,
    } as unknown as PerspectiveViewRenderContext;
  }

  function drawLayer(
    gl: GL,
    source: PaintedVolumeRenderSource,
    context: PerspectiveViewRenderContext,
  ): Rendered {
    const layer = new PaintedVolumeRenderLayer(gl, source);
    try {
      return renderPanel(gl, () => layer.draw(context));
    } finally {
      layer.dispose();
    }
  }

  const scene: Scene = {
    texels: [{ texel: [4, 4, 3], segmentClass: CLASS_A }],
  };

  it("is opaque and always ready", () => {
    webglTest((gl) => {
      withSource(gl, scene, (source) => {
        const layer = new PaintedVolumeRenderLayer(gl, source);
        try {
          expect(layer.isTransparent).toBe(false);
          expect(layer.isReady()).toBe(true);
        } finally {
          layer.dispose();
        }
      });
    });
  });

  it("draws in the panel's opaque colour pass", () => {
    webglTest((gl) => {
      withSource(gl, scene, (source) => {
        const rendered = drawLayer(
          gl,
          source,
          renderContext(perspectivePanelEmit),
        );
        expect(pixel(rendered, CENTER_PIXEL, CENTER_PIXEL)).toEqual(COLOR_A);
      });
    });
  });

  it("skips passes with another emitter or without colour", () => {
    webglTest((gl) => {
      withSource(gl, scene, (source) => {
        const otherEmitter = drawLayer(
          gl,
          source,
          renderContext(() => {}),
        );
        expect(countPixels(otherEmitter, BACKGROUND)).toBe(
          FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE,
        );
        const pickOnly = drawLayer(
          gl,
          source,
          renderContext(perspectivePanelEmit, false),
        );
        expect(countPixels(pickOnly, BACKGROUND)).toBe(
          FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE,
        );
      });
    });
  });

  it("draws nothing without an occupied box", () => {
    webglTest((gl) => {
      withSource(gl, scene, (source) => {
        const rendered = drawLayer(
          gl,
          { ...source, occupiedBox: undefined },
          renderContext(perspectivePanelEmit),
        );
        expect(countPixels(rendered, BACKGROUND)).toBe(
          FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE,
        );
      });
    });
  });

  it("restores face culling and the active texture unit", () => {
    webglTest((gl) => {
      withSource(gl, scene, (source) => {
        const layer = new PaintedVolumeRenderLayer(gl, source);
        try {
          // Inside the panel draw: binding the framebuffer itself moves the
          // active unit, so the state is set and checked around draw() only.
          renderPanel(gl, () => {
            gl.disable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
            gl.activeTexture(gl.TEXTURE5);
            layer.draw(renderContext(perspectivePanelEmit));
            expect(gl.isEnabled(gl.CULL_FACE)).toBe(false);
            expect(gl.getParameter(gl.CULL_FACE_MODE)).toBe(gl.BACK);
            expect(gl.getParameter(gl.ACTIVE_TEXTURE)).toBe(gl.TEXTURE5);
          });
        } finally {
          layer.dispose();
        }
      });
    });
  });
});
