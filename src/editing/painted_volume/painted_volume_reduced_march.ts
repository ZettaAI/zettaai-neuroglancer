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
 * @file Ray-marches the preview into a smaller framebuffer and stretches the
 * result over the panel, for GPUs too slow to march every pixel.
 *
 * The small framebuffer has the panel's own attachments (colour, z, pick id,
 * depth), so the march shader runs unchanged and only the viewport shrinks.
 * The stretch pass then writes each panel pixel from the nearest small pixel:
 * colour, the panel's `out_z`, the pick id, and `gl_FragDepth` from the stored
 * z, so the panel's depth test, stencil and mouse picking treat the stretched
 * surface exactly like a full-resolution one. Small pixels the march left
 * empty (z cleared to 0: nothing hit) are discarded, so what lies behind the
 * preview shows through.
 *
 * Nearest, not linear: pick ids and depths must not be blended across an
 * edge. The edges of the surface come out blocky by the reduction, which is
 * the price of a frame that no longer resets a slow GPU.
 */

import { OffscreenTextures } from "#src/perspective_view/panel.js";
import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import {
  DepthStencilRenderbuffer,
  FramebufferConfiguration,
  TextureBuffer,
} from "#src/webgl/offscreen.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

/** Panel z the march writes where nothing was hit: the panel clears it so. */
const NOTHING_HIT_Z = 0;
const FULL_SCREEN_TRIANGLE_VERTICES = 3;

/** The small target's attachments, in `OffscreenTextures` order. */
const STRETCH_SAMPLERS = [
  { name: "uColor", symbol: Symbol("reducedMarchColor") },
  { name: "uZ", symbol: Symbol("reducedMarchZ") },
  { name: "uPickId", symbol: Symbol("reducedMarchPickId") },
] as const;

function buildStretchShader(gl: GL): ShaderProgram {
  const builder = new ShaderBuilder(gl);
  builder.addOutputBuffer("vec4", "out_color", OffscreenTextures.COLOR);
  builder.addOutputBuffer("highp vec4", "out_z", OffscreenTextures.Z);
  builder.addOutputBuffer("highp vec4", "out_pickId", OffscreenTextures.PICK);
  for (const sampler of STRETCH_SAMPLERS) {
    builder.addTextureSampler("sampler2D", sampler.name, sampler.symbol);
  }
  builder.addUniform("highp vec2", "uViewportOrigin");
  builder.addUniform("highp float", "uReduction");
  builder.addUniform("highp ivec2", "uSmallSize");
  // One triangle covering the viewport, from the vertex index alone.
  builder.setVertexMain(`
vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
`);
  builder.setFragmentMain(`
ivec2 small = ivec2(floor((gl_FragCoord.xy - uViewportOrigin) / uReduction));
small = clamp(small, ivec2(0), uSmallSize - 1);
highp vec4 z = texelFetch(uZ, small, 0);
if (z.r == ${NOTHING_HIT_Z.toFixed(1)}) discard;
out_color = texelFetch(uColor, small, 0);
out_z = z;
out_pickId = texelFetch(uPickId, small, 0);
gl_FragDepth = 1.0 - z.r;
`);
  return builder.build();
}

export class PaintedVolumeReducedMarch extends RefCounted {
  private readonly target: FramebufferConfiguration<TextureBuffer>;
  private readonly stretchShader: ShaderProgram;

  constructor(private readonly gl: GL) {
    super();
    this.target = this.registerDisposer(
      new FramebufferConfiguration(gl, {
        colorBuffers: [
          new TextureBuffer(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
          new TextureBuffer(gl, gl.R32F, gl.RED, gl.FLOAT),
          new TextureBuffer(gl, gl.R32F, gl.RED, gl.FLOAT),
        ],
        depthBuffer: new DepthStencilRenderbuffer(gl),
      }),
    );
    this.stretchShader = buildStretchShader(gl);
  }

  /**
   * Run `march` into a framebuffer `reduction` times smaller than the bound
   * viewport, then stretch it over that viewport in the bound framebuffer.
   * Framebuffer, viewport, stencil and culling state are restored.
   */
  draw(reduction: number, march: () => void): void {
    const { gl } = this;
    const panelFramebuffer = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const [viewportX, viewportY, viewportWidth, viewportHeight] = viewport;
    const smallWidth = Math.max(1, Math.ceil(viewportWidth / reduction));
    const smallHeight = Math.max(1, Math.ceil(viewportHeight / reduction));
    const stencilWasEnabled = gl.isEnabled(gl.STENCIL_TEST);
    // Resizing the small target binds textures on NG's temporary unit.
    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;

    this.marchSmall(smallWidth, smallHeight, march);

    gl.bindFramebuffer(gl.FRAMEBUFFER, panelFramebuffer);
    gl.viewport(viewportX, viewportY, viewportWidth, viewportHeight);
    if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
    this.stretch(reduction, viewportX, viewportY, smallWidth, smallHeight);
    gl.activeTexture(previousActiveTexture);
  }

  override disposed(): void {
    this.stretchShader.dispose();
    super.disposed();
  }

  private marchSmall(width: number, height: number, march: () => void): void {
    const { gl, target } = this;
    target.bind(width, height);
    // The small target only ever holds this layer; the panel's stencil
    // bookkeeping happens in the stretch pass.
    gl.disable(gl.STENCIL_TEST);
    gl.clearBufferfv(gl.COLOR, OffscreenTextures.COLOR, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, OffscreenTextures.Z, [NOTHING_HIT_Z, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, OffscreenTextures.PICK, [0, 0, 0, 0]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    march();
  }

  private stretch(
    reduction: number,
    viewportX: number,
    viewportY: number,
    smallWidth: number,
    smallHeight: number,
  ): void {
    const { gl, target, stretchShader } = this;
    const cullFaceWasEnabled = gl.isEnabled(gl.CULL_FACE);
    gl.disable(gl.CULL_FACE);
    stretchShader.bind();
    STRETCH_SAMPLERS.forEach((sampler, index) => {
      gl.activeTexture(gl.TEXTURE0 + stretchShader.textureUnit(sampler.symbol));
      gl.bindTexture(gl.TEXTURE_2D, target.colorBuffers[index].texture);
    });
    gl.uniform2f(
      stretchShader.uniform("uViewportOrigin"),
      viewportX,
      viewportY,
    );
    gl.uniform1f(stretchShader.uniform("uReduction"), reduction);
    gl.uniform2i(stretchShader.uniform("uSmallSize"), smallWidth, smallHeight);
    gl.drawArrays(gl.TRIANGLES, 0, FULL_SCREEN_TRIANGLE_VERTICES);
    for (const sampler of STRETCH_SAMPLERS) {
      gl.activeTexture(gl.TEXTURE0 + stretchShader.textureUnit(sampler.symbol));
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    if (cullFaceWasEnabled) gl.enable(gl.CULL_FACE);
  }
}
