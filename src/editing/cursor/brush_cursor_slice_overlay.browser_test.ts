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
 * Real-WebGL2 checks for the slice cursor. Its shape lives entirely in GLSL, so
 * every way it can be wrong is invisible to `tsc`: a shader that fails to compile
 * (cursor silently never appears), a painted-set test that disagrees with the CPU
 * definition, or a footprint that lands on the wrong voxels on screen. These
 * tests rasterize the real draw path into an offscreen buffer and read the pixels
 * back, so the assertion is on what the user would actually see.
 */

import { Resolution } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import { resolveCursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import {
  buildFootprintShader,
  PaintedFootprintRenderer,
} from "#src/editing/cursor/brush_cursor_slice_overlay.js";
import { computePaintedFootprintSliceQuad } from "#src/editing/cursor/painted_footprint_slice_quad.js";
import { targetVoxelToGlobal } from "#src/editing/raster/global_voxel_conversion.js";
import {
  brushFootprintContains,
  brushRadiusSquared,
  glsl_brushFootprintContains,
} from "#src/editing/tool_runtimes/brush_disk_footprint.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import { mat4, quat, vec3 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import {
  FramebufferConfiguration,
  TextureBuffer,
} from "#src/webgl/offscreen.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";
import { webglTest } from "#src/webgl/testing.js";

// A 4 nm global coordinate space, a 32 nm paint target, and one screen pixel per
// global unit — so one target voxel is exactly 8 px and voxel boundaries land on
// integer pixels, making the rasterized footprint checkable pixel by pixel.
const GLOBAL_VOXEL_SIZE_NM = 4;
const TARGET_VOXEL_SIZE_NM = 32;
const PIXELS_PER_VOXEL = TARGET_VOXEL_SIZE_NM / GLOBAL_VOXEL_SIZE_NM;
const FRAMEBUFFER_SIZE = 128;
/** The viewport center in GL window coordinates; NDC (0, 0) lands here. */
const CENTER_PIXEL = FRAMEBUFFER_SIZE / 2;

const PAINTED_RADIUS = 3;
/** One voxel past the disk on every side, so an oversized footprint is caught. */
const SWEEP_LIMIT = PAINTED_RADIUS + 1;

/** Slice orientations, as the view rotation the navigation pose applies. */
const ORIENTATIONS = {
  /** Screen X → global X, screen Y → global Y. Slice normal: global Z. */
  xy: quat.create(),
  /** Screen X → global X, screen Y → global Z. Slice normal: global Y. */
  xz: quat.setAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2),
  /** Screen X → global −Z, screen Y → global Y. Slice normal: global X. */
  yz: quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2),
};

const POINTER_VOXEL = [100.5, 200.5, 50.5] as const;

function displayInfo(): DisplayDimensionRenderInfo {
  const scaleMeters = GLOBAL_VOXEL_SIZE_NM * 1e-9;
  return {
    displayRank: 3,
    displayDimensionIndices: Int32Array.from([0, 1, 2]),
    displayDimensionScales: Float64Array.from([
      scaleMeters,
      scaleMeters,
      scaleMeters,
    ]),
    displayDimensionUnits: ["m", "m", "m"],
  } as unknown as DisplayDimensionRenderInfo;
}

const cursorFrame = () =>
  resolveCursorVoxelFrame(
    Resolution.from([
      TARGET_VOXEL_SIZE_NM,
      TARGET_VOXEL_SIZE_NM,
      TARGET_VOXEL_SIZE_NM,
    ]),
    displayInfo(),
  )!;

function voxelToGlobal(voxel: readonly [number, number, number]) {
  const frame = cursorFrame();
  return targetVoxelToGlobal(
    [voxel[0], voxel[1], voxel[2]],
    frame.globalVoxelSizeNm,
    frame.targetVoxelSizeNm,
  );
}

/**
 * Slice view/projection pair: the inverse view matrix is the navigation pose
 * (orientation, one global unit per view unit, translated to the viewport
 * center), and the projection is orthographic over the framebuffer — so one
 * global unit is one pixel.
 */
function sliceProjection(
  orientation: quat,
  viewCenterVoxel: readonly [number, number, number],
) {
  const viewCenterGlobal = voxelToGlobal(viewCenterVoxel);
  const invViewMatrix = mat4.fromQuat(mat4.create(), orientation);
  for (let row = 0; row < 3; ++row) {
    invViewMatrix[12 + row] = viewCenterGlobal[row];
  }
  const viewProjectionMat = mat4.multiply(
    mat4.create(),
    mat4.ortho(
      mat4.create(),
      -FRAMEBUFFER_SIZE / 2,
      FRAMEBUFFER_SIZE / 2,
      -FRAMEBUFFER_SIZE / 2,
      FRAMEBUFFER_SIZE / 2,
      -1000,
      1000,
    ),
    mat4.invert(mat4.create(), invViewMatrix)!,
  );
  return {
    viewProjectionMat,
    invViewProjectionMat: mat4.invert(mat4.create(), viewProjectionMat)!,
  };
}

/**
 * Rasterize one footprint through the real draw path and return the alpha
 * channel, row-major in GL window order (bottom-up). The cursor draws white over
 * a cleared buffer, so alpha alone distinguishes outline (highest), fill, and
 * untouched.
 */
function rasterizeFootprint(
  gl: GL,
  options: {
    orientation: quat;
    paintedRadius?: number;
    pointerVoxel?: readonly [number, number, number];
    /** Defaults to the pointer, i.e. the cursor sits at the viewport center. */
    viewCenterVoxel?: readonly [number, number, number];
  },
): Uint8Array {
  const paintedRadius = options.paintedRadius ?? PAINTED_RADIUS;
  const pointerVoxel = options.pointerVoxel ?? POINTER_VOXEL;
  const projection = sliceProjection(
    options.orientation,
    options.viewCenterVoxel ?? pointerVoxel,
  );
  const pointerGlobal = voxelToGlobal(pointerVoxel);
  const quad = computePaintedFootprintSliceQuad({
    radiusVoxels: paintedRadius,
    worldCenter: vec3.fromValues(
      pointerGlobal[0],
      pointerGlobal[1],
      pointerGlobal[2],
    ),
    frame: cursorFrame(),
    viewProjectionMat: projection.viewProjectionMat,
    invViewProjectionMat: projection.invViewProjectionMat,
    viewportWidth: FRAMEBUFFER_SIZE,
    viewportHeight: FRAMEBUFFER_SIZE,
    marginPixels: 3,
  });
  expect(quad).toBeDefined();

  // Two color attachments, matching the slice panel's color + pickId draw
  // buffers — the shader writes both, and a mismatch here is a GL error.
  const framebuffer = new FramebufferConfiguration(gl, {
    colorBuffers: [0, 1].map(
      () => new TextureBuffer(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
    ),
  });
  const renderer = new PaintedFootprintRenderer(gl);
  const pixels = new Uint8Array(FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE * 4);
  try {
    framebuffer.bind(FRAMEBUFFER_SIZE, FRAMEBUFFER_SIZE);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.draw(quad!, brushRadiusSquared(paintedRadius));
    framebuffer.bindSingle(0);
    gl.readPixels(
      0,
      0,
      FRAMEBUFFER_SIZE,
      FRAMEBUFFER_SIZE,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    expect(gl.getError()).toBe(gl.NO_ERROR);
  } finally {
    framebuffer.unbind();
    renderer.dispose();
    framebuffer.dispose();
  }
  const alpha = new Uint8Array(FRAMEBUFFER_SIZE * FRAMEBUFFER_SIZE);
  for (let i = 0; i < alpha.length; ++i) alpha[i] = pixels[i * 4 + 3];
  return alpha;
}

/** Alpha at a screen position, given in voxel steps from the viewport center. */
function alphaAtVoxelStep(
  alpha: Uint8Array,
  screenStepX: number,
  screenStepY: number,
): number {
  return alphaAtPixelOffset(
    alpha,
    screenStepX * PIXELS_PER_VOXEL,
    screenStepY * PIXELS_PER_VOXEL,
  );
}

/** Alpha at a screen position, given in pixels from the viewport center. */
function alphaAtPixelOffset(
  alpha: Uint8Array,
  pixelOffsetX: number,
  pixelOffsetY: number,
): number {
  const pixelX = Math.round(CENTER_PIXEL + pixelOffsetX);
  const pixelY = Math.round(CENTER_PIXEL + pixelOffsetY);
  return alpha[pixelY * FRAMEBUFFER_SIZE + pixelX];
}

describe("slice cursor shader", () => {
  it("compiles and links", () => {
    webglTest((gl) => {
      const shader = buildFootprintShader(gl);
      try {
        // `ShaderBuilder.build` throws on a compile or link failure, so reaching
        // here means the program is live; confirm the attributes and uniforms the
        // draw path binds actually resolved.
        expect(shader.attribute("aCornerNdc")).toBeGreaterThanOrEqual(0);
        expect(shader.attribute("aVoxelOffset")).toBeGreaterThanOrEqual(0);
        for (const uniform of [
          "uRadiusSquared",
          "uOutlineHalfWidthPixels",
          "uFillAlpha",
          "uOutlineAlpha",
        ]) {
          expect(shader.uniform(uniform), uniform).not.toBeNull();
        }
      } finally {
        shader.dispose();
      }
    });
  });

  it("agrees with the CPU painted-set definition", () => {
    fragmentShaderTest(
      {
        offsetX: "float",
        offsetY: "float",
        offsetZ: "float",
        radiusSquared: "float",
      },
      { inside: "bool" },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_brushFootprintContains);
        builder.setFragmentMain(
          "inside = footprintContains(vec3(offsetX, offsetY, offsetZ), radiusSquared);",
        );
        for (const paintedRadius of [0, 1, 3, 7]) {
          const limit = paintedRadius + 1;
          for (let offsetZ = -1; offsetZ <= 1; ++offsetZ) {
            for (let offsetY = -limit; offsetY <= limit; ++offsetY) {
              for (let offsetX = -limit; offsetX <= limit; ++offsetX) {
                tester.execute({
                  offsetX,
                  offsetY,
                  offsetZ,
                  radiusSquared: brushRadiusSquared(paintedRadius),
                });
                expect(
                  tester.values.inside,
                  `radius=${paintedRadius} offset=(${offsetX},${offsetY},${offsetZ})`,
                ).toBe(
                  brushFootprintContains(
                    offsetX,
                    offsetY,
                    offsetZ,
                    paintedRadius * paintedRadius,
                  ),
                );
              }
            }
          }
        }
      },
    );
  });
});

describe("rasterized brush footprint", () => {
  it("fills exactly the voxels the brush would paint (XY view)", () => {
    webglTest((gl) => {
      const alpha = rasterizeFootprint(gl, { orientation: ORIENTATIONS.xy });
      for (let offsetY = -SWEEP_LIMIT; offsetY <= SWEEP_LIMIT; ++offsetY) {
        for (let offsetX = -SWEEP_LIMIT; offsetX <= SWEEP_LIMIT; ++offsetX) {
          const painted = brushFootprintContains(
            offsetX,
            offsetY,
            0,
            brushRadiusSquared(PAINTED_RADIUS),
          );
          expect(
            alphaAtVoxelStep(alpha, offsetX, offsetY) > 0,
            `voxel (${offsetX}, ${offsetY})`,
          ).toBe(painted);
        }
      }
    });
  });

  it("has staircase corners, not a smooth circle", () => {
    webglTest((gl) => {
      const alpha = rasterizeFootprint(gl, { orientation: ORIENTATIONS.xy });
      // For radius 3 the rows are 1, 5, 5, 7, 5, 5, 1 voxels wide. A circle of
      // radius 3.5 would cover (3, 1) and (1, 3); the stamped disk does not.
      for (const [offsetX, offsetY] of [
        [3, 0],
        [0, 3],
        [2, 2],
      ]) {
        expect(
          alphaAtVoxelStep(alpha, offsetX, offsetY),
          `inside (${offsetX}, ${offsetY})`,
        ).toBeGreaterThan(0);
      }
      for (const [offsetX, offsetY] of [
        [3, 1],
        [1, 3],
        [3, 3],
      ]) {
        expect(
          alphaAtVoxelStep(alpha, offsetX, offsetY),
          `outside (${offsetX}, ${offsetY})`,
        ).toBe(0);
      }
    });
  });

  it("draws the outline on the voxel boundary", () => {
    webglTest((gl) => {
      const alpha = rasterizeFootprint(gl, { orientation: ORIENTATIONS.xy });
      const interior = alphaAtVoxelStep(alpha, 0, 0);
      // The disk's rightmost voxel in the center row is offset 3, so its outer
      // face is 3.5 voxels — 28 px — right of the center. Pixel centers sit at
      // integer + 0.5, so the pixel at offset 27 is half a pixel inside that
      // face and the one at offset 28 is half a pixel outside it: the outline
      // straddles the boundary rather than sitting wholly within the voxel.
      const outerFacePixels = (PAINTED_RADIUS + 0.5) * PIXELS_PER_VOXEL;
      const justInside = alphaAtPixelOffset(alpha, outerFacePixels - 1, 0);
      const justOutside = alphaAtPixelOffset(alpha, outerFacePixels, 0);
      expect(justInside).toBeGreaterThan(interior);
      expect(justOutside).toBeGreaterThan(interior);
      // ...and it is a thin line, not a halo.
      expect(alphaAtPixelOffset(alpha, outerFacePixels + 3, 0)).toBe(0);
    });
  });

  it("is one voxel thick in the XZ view", () => {
    webglTest((gl) => {
      // Screen X → global X, screen Y → global Z.
      const alpha = rasterizeFootprint(gl, { orientation: ORIENTATIONS.xz });
      for (
        let offsetX = -PAINTED_RADIUS;
        offsetX <= PAINTED_RADIUS;
        ++offsetX
      ) {
        expect(
          alphaAtVoxelStep(alpha, offsetX, 0),
          `x=${offsetX}`,
        ).toBeGreaterThan(0);
        for (const offsetZ of [-1, 1]) {
          expect(
            alphaAtVoxelStep(alpha, offsetX, offsetZ),
            `x=${offsetX} z=${offsetZ}`,
          ).toBe(0);
        }
      }
      // The slab spans the full diameter, and stops there.
      expect(alphaAtVoxelStep(alpha, PAINTED_RADIUS + 1, 0)).toBe(0);
    });
  });

  it("is one voxel thick in the YZ view", () => {
    webglTest((gl) => {
      // Screen X → global −Z, screen Y → global Y.
      const alpha = rasterizeFootprint(gl, { orientation: ORIENTATIONS.yz });
      for (
        let offsetY = -PAINTED_RADIUS;
        offsetY <= PAINTED_RADIUS;
        ++offsetY
      ) {
        expect(
          alphaAtVoxelStep(alpha, 0, offsetY),
          `y=${offsetY}`,
        ).toBeGreaterThan(0);
        for (const offsetZ of [-1, 1]) {
          expect(
            alphaAtVoxelStep(alpha, offsetZ, offsetY),
            `y=${offsetY} z=${offsetZ}`,
          ).toBe(0);
        }
      }
      expect(alphaAtVoxelStep(alpha, 0, PAINTED_RADIUS + 1)).toBe(0);
    });
  });

  it("does not move or reshape while the pointer stays in one voxel", () => {
    webglTest((gl) => {
      // The view is pinned, so any difference is the footprint itself moving.
      const nearLowerCorner = rasterizeFootprint(gl, {
        orientation: ORIENTATIONS.xy,
        pointerVoxel: [100.05, 200.05, 50.5],
        viewCenterVoxel: POINTER_VOXEL,
      });
      const nearUpperCorner = rasterizeFootprint(gl, {
        orientation: ORIENTATIONS.xy,
        pointerVoxel: [100.95, 200.95, 50.5],
        viewCenterVoxel: POINTER_VOXEL,
      });
      for (let offsetY = -SWEEP_LIMIT; offsetY <= SWEEP_LIMIT; ++offsetY) {
        for (let offsetX = -SWEEP_LIMIT; offsetX <= SWEEP_LIMIT; ++offsetX) {
          expect(
            alphaAtVoxelStep(nearUpperCorner, offsetX, offsetY),
            `voxel (${offsetX}, ${offsetY})`,
          ).toBe(alphaAtVoxelStep(nearLowerCorner, offsetX, offsetY));
        }
      }
    });
  });

  it("steps a whole voxel when the pointer crosses a voxel boundary", () => {
    webglTest((gl) => {
      const beforeCrossing = rasterizeFootprint(gl, {
        orientation: ORIENTATIONS.xy,
        pointerVoxel: [100.95, 200.5, 50.5],
        viewCenterVoxel: POINTER_VOXEL,
      });
      const afterCrossing = rasterizeFootprint(gl, {
        orientation: ORIENTATIONS.xy,
        pointerVoxel: [101.05, 200.5, 50.5],
        viewCenterVoxel: POINTER_VOXEL,
      });
      // Same shape, translated by exactly one voxel along X.
      for (let offsetY = -SWEEP_LIMIT; offsetY <= SWEEP_LIMIT; ++offsetY) {
        for (let offsetX = -SWEEP_LIMIT; offsetX < SWEEP_LIMIT; ++offsetX) {
          expect(
            alphaAtVoxelStep(afterCrossing, offsetX + 1, offsetY),
            `voxel (${offsetX}, ${offsetY})`,
          ).toBe(alphaAtVoxelStep(beforeCrossing, offsetX, offsetY));
        }
      }
    });
  });

  it("straddles a voxel boundary at an even size", () => {
    webglTest((gl) => {
      // Size 4 → radius 1.5 → the stamp centres on the voxel BOUNDARY nearest
      // the pointer. The pointer sits at x.5, so that is the boundary above its
      // own voxel, and the four voxels across straddle it two and two: offsets
      // -1, 0 below it and 1, 2 above. An even size has no middle voxel to
      // centre on, so the footprint is deliberately not centred on the
      // pointer's voxel — it is symmetric about the boundary instead.
      const alpha = rasterizeFootprint(gl, {
        orientation: ORIENTATIONS.xy,
        paintedRadius: 1.5,
      });
      const litOffsets: number[] = [];
      for (let offsetX = -4; offsetX <= 4; ++offsetX) {
        if (alphaAtVoxelStep(alpha, offsetX, 0) > 0) litOffsets.push(offsetX);
      }
      expect(litOffsets).toEqual([-1, 0, 1, 2]);
      // Twelve voxels, matching the shared shape definition.
      let lit = 0;
      for (let offsetY = -4; offsetY <= 4; ++offsetY) {
        for (let offsetX = -4; offsetX <= 4; ++offsetX) {
          if (alphaAtVoxelStep(alpha, offsetX, offsetY) > 0) ++lit;
        }
      }
      expect(lit).toBe(12);
    });
  });

  it("covers exactly one voxel at brush size 1", () => {
    webglTest((gl) => {
      const alpha = rasterizeFootprint(gl, {
        orientation: ORIENTATIONS.xy,
        paintedRadius: 0,
      });
      expect(alphaAtVoxelStep(alpha, 0, 0)).toBeGreaterThan(0);
      for (const [offsetX, offsetY] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        expect(
          alphaAtVoxelStep(alpha, offsetX, offsetY),
          `voxel (${offsetX}, ${offsetY})`,
        ).toBe(0);
      }
    });
  });
});
