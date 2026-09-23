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
 * @file The trace cursor sphere where a slice plane cuts it.
 *
 * The cross-section is evaluated per fragment from the fragment's own global
 * position rather than derived on the CPU. Cutting an ellipsoid with an
 * arbitrary plane is real work, and an oblique slice makes it real work with
 * cases; testing the ellipsoid directly has neither, and it stays correct in
 * every orientation by construction. The cost is one viewport-sized quad per
 * slice panel, with a shader of a dozen instructions.
 */

import {
  TRACE_SPHERE_RGB,
  TRACE_SPHERE_SLICE_FILL_ALPHA,
  TRACE_SPHERE_SLICE_OUTLINE_ALPHA,
} from "#src/datasource/calcada/trace_cursor/trace_sphere_appearance.js";
import {
  SLICE_QUAD_CORNERS_NDC,
  sliceQuadGlobalCorners,
  traceSphereSemiAxes,
} from "#src/datasource/calcada/trace_cursor/trace_sphere_geometry.js";
import type { TraceSphereState } from "#src/datasource/calcada/trace_cursor/trace_sphere_state.js";
import type {
  SliceViewPanelReadyRenderContext,
  SliceViewPanelRenderContext,
} from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import { RefCounted } from "#src/util/disposable.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

const CORNER_COUNT = 4;

class TraceSphereSliceRenderer extends RefCounted {
  private shader: ShaderProgram;
  private cornerNdcBuffer: GLBuffer;
  private globalPositionBuffer: GLBuffer;

  constructor(private gl: GL) {
    super();
    this.shader = this.registerDisposer(buildSliceSphereShader(gl));
    this.cornerNdcBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        SLICE_QUAD_CORNERS_NDC,
        gl.ARRAY_BUFFER,
        gl.STATIC_DRAW,
      ),
    );
    this.globalPositionBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        new Float32Array(CORNER_COUNT * 3),
        gl.ARRAY_BUFFER,
        gl.DYNAMIC_DRAW,
      ),
    );
  }

  draw(
    globalCorners: Float32Array,
    center: Float32Array,
    semiAxes: Float32Array,
  ) {
    const { gl, shader } = this;
    this.globalPositionBuffer.setData(globalCorners, gl.DYNAMIC_DRAW);
    shader.bind();
    gl.uniform3f(shader.uniform("uCenter"), center[0], center[1], center[2]);
    gl.uniform3f(
      shader.uniform("uSemiAxes"),
      semiAxes[0],
      semiAxes[1],
      semiAxes[2],
    );
    gl.uniform3fv(shader.uniform("uColor"), TRACE_SPHERE_RGB);
    gl.uniform1f(shader.uniform("uFillAlpha"), TRACE_SPHERE_SLICE_FILL_ALPHA);
    gl.uniform1f(
      shader.uniform("uOutlineAlpha"),
      TRACE_SPHERE_SLICE_OUTLINE_ALPHA,
    );

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    const aCornerNdc = shader.attribute("aCornerNdc");
    const aGlobalPosition = shader.attribute("aGlobalPosition");
    this.cornerNdcBuffer.bindToVertexAttrib(aCornerNdc, 2);
    this.globalPositionBuffer.bindToVertexAttrib(aGlobalPosition, 3);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, CORNER_COUNT);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(aCornerNdc);
    gl.disableVertexAttribArray(aGlobalPosition);
  }
}

export class TraceSphereSliceOverlay extends SliceViewPanelRenderLayer {
  override drawOrderPriority = 21;
  private renderer: TraceSphereSliceRenderer;

  constructor(
    public gl: GL,
    public state: TraceSphereState,
  ) {
    super();
    this.renderer = this.registerDisposer(new TraceSphereSliceRenderer(gl));
    this.registerDisposer(
      state.visible.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(state.center.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(
      state.radiusNm.changed.add(this.redrawNeeded.dispatch),
    );
  }

  override isReady(_renderContext: SliceViewPanelReadyRenderContext): boolean {
    return true;
  }

  override draw(renderContext: SliceViewPanelRenderContext): void {
    if (!renderContext.emitColor) return;
    const { state } = this;
    if (state.visible.value !== true) return;
    const center = state.center.value;
    if (center === undefined) return;
    const { projectionParameters } = renderContext;
    const semiAxes = traceSphereSemiAxes(
      state.radiusNm.value,
      state.coordinateSpace.value,
    );
    if (semiAxes === undefined) return;
    this.renderer.draw(
      sliceQuadGlobalCorners(projectionParameters.invViewProjectionMat),
      center,
      semiAxes,
    );
  }
}

/**
 * Writes BOTH slice-panel attachments (color and pickId). The panel binds both,
 * and a shader that fills only one raises GL_INVALID_OPERATION. The cursor is
 * not pickable, so its pickId is zero.
 */
function buildSliceSphereShader(gl: GL): ShaderProgram {
  const builder = new ShaderBuilder(gl);
  builder.addAttribute("vec2", "aCornerNdc");
  builder.addAttribute("vec3", "aGlobalPosition");
  builder.addVarying("highp vec3", "vGlobalPosition");
  builder.addUniform("highp vec3", "uCenter");
  builder.addUniform("highp vec3", "uSemiAxes");
  builder.addUniform("vec3", "uColor");
  builder.addUniform("highp float", "uFillAlpha");
  builder.addUniform("highp float", "uOutlineAlpha");
  builder.addOutputBuffer("vec4", "out_fragColor", 0);
  builder.addOutputBuffer("highp vec4", "out_pickId", 1);
  builder.setVertexMain(`
vGlobalPosition = aGlobalPosition;
gl_Position = vec4(aCornerNdc, 0.0, 1.0);
`);
  builder.setFragmentMain(`
vec3 scaled = (vGlobalPosition - uCenter) / uSemiAxes;
float radiusFraction = length(scaled);
// Outline width taken from the derivative rather than a fixed value in world
// units: that is what keeps the rim the same thickness on screen at any zoom
// and in any slice orientation.
float edge = fwidth(radiusFraction);
if (radiusFraction > 1.0 + edge) discard;
float outline = smoothstep(1.0 - edge, 1.0, radiusFraction);
out_fragColor = vec4(uColor, mix(uFillAlpha, uOutlineAlpha, outline));
out_pickId = vec4(0.0, 0.0, 0.0, 0.0);
`);
  return builder.build();
}
