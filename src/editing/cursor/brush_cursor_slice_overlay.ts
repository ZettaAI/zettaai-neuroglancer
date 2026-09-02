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
 * @file Slice-view brush cursor overlay. Draws the EXACT set of voxels the
 * brush would write — a translucent fill with a staircase outline that traces
 * target-layer voxel boundaries.
 *
 * A smooth circle was a lie: the brush stamps whole voxels of the TARGET layer's
 * grid (`brush_cursor_footprint.ts`), so a circular cursor promised paint on
 * partially-covered voxels that the stamp never touches, and drifted up to half
 * a voxel off the stamp center as the pointer moved inside a voxel. The cursor
 * now sits on the target grid: it is symmetric about the stamp's center voxel
 * and translates a whole voxel at a time, never changing shape.
 *
 * The footprint is quantized on the TARGET layer's resolution, which is
 * generally not the resolution of the image layer being displayed — the cursor's
 * "pixels" are the ones the write lands on, not the ones on screen.
 *
 * IMPLEMENTATION. One screen quad covering the footprint's projected bounds
 * (`painted_footprint_slice_quad.ts`), with each fragment's target-voxel
 * coordinate interpolated across it. The fragment shader floors that to a voxel
 * and evaluates the painted-set test directly, so the drawn shape is the painted
 * shape by construction — at any brush size, on any voxel aspect ratio, and in
 * every slice orientation. In the XZ / YZ orthogonal views the disk is edge-on
 * and this yields the one-voxel-thick slab the stamp actually writes (where a
 * projected ellipse collapsed to a zero-height line); in an oblique view it
 * yields the true cross-section.
 *
 * The outline is derived in the same pass: a fragment is on the boundary when
 * one of its six voxel neighbours falls on the other side of the painted-set
 * test, and its distance to that shared face — converted to pixels via the
 * fragment derivatives of the voxel coordinate — gives an antialiased line of
 * constant screen width. Faces that are edge-on (their axis runs into the
 * screen) measure as infinitely far and drop out on their own, which is what
 * keeps the slab's front and back faces from flooding an axis-aligned view.
 */

import { resolveCursorVoxelFrame } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { BrushCursorState } from "#src/editing/cursor/brush_cursor_state.js";
import type { PaintedFootprintSliceQuad } from "#src/editing/cursor/painted_footprint_slice_quad.js";
import { computePaintedFootprintSliceQuad } from "#src/editing/cursor/painted_footprint_slice_quad.js";
import {
  brushRadius,
  brushRadiusSquared,
  glsl_brushFootprintContains,
} from "#src/editing/tool_runtimes/brush_disk_footprint.js";
import type {
  SliceViewPanelRenderContext,
  SliceViewPanelReadyRenderContext,
} from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import { RefCounted } from "#src/util/disposable.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

const CORNER_COUNT = 4;
/** Interleaved per-corner vertex: NDC (x, y) then voxel offset (x, y, z). */
const FLOATS_PER_CORNER = 5;
const NDC_OFFSET_BYTES = 0;
const VOXEL_OFFSET_BYTES = 2 * Float32Array.BYTES_PER_ELEMENT;
const VERTEX_STRIDE_BYTES = FLOATS_PER_CORNER * Float32Array.BYTES_PER_ELEMENT;

// Brush and eraser share one neutral cursor: a soft white fill that gently
// brightens the slice (no color cast), with a subtle rim. Identical for both
// tools so the cursor reads the same regardless of brush vs eraser.
const CURSOR_OUTLINE_ALPHA = 0.5;
const CURSOR_FILL_ALPHA = 0.12;

/**
 * Half-width of the staircase outline in pixels. The line straddles the voxel
 * boundary, so the drawn width is twice this plus the antialiasing ramp.
 */
const OUTLINE_HALF_WIDTH_PIXELS = 0.75;

/**
 * Slack around the footprint's projected bounds, so the outline's outer half
 * (which falls on voxels outside the painted set) is not clipped away.
 */
const QUAD_MARGIN_PIXELS = OUTLINE_HALF_WIDTH_PIXELS + 1.5;

/**
 * Owns the shader and vertex buffer, and draws one footprint quad. Separated
 * from the render layer so it can be driven without a panel — see
 * `brush_cursor_slice_overlay.browser_test.ts`, which rasterizes a footprint and
 * checks the resulting pixels against the painted voxel set.
 */
export class PaintedFootprintRenderer extends RefCounted {
  private cornerBuffer: GLBuffer;
  private cornerData = new Float32Array(CORNER_COUNT * FLOATS_PER_CORNER);
  private shader: ShaderProgram;

  constructor(public gl: GL) {
    super();
    this.cornerBuffer = this.registerDisposer(
      new GLBuffer(gl, gl.ARRAY_BUFFER),
    );
    this.shader = this.registerDisposer(buildFootprintShader(gl));
  }

  draw(quad: PaintedFootprintSliceQuad, radiusSquared: number): void {
    const { gl, shader } = this;
    this.uploadQuad(quad.cornersNdc, quad.cornerVoxelOffsets);

    shader.bind();
    this.setFootprintUniforms(radiusSquared, quad.anchorOffset);

    const aCornerNdc = shader.attribute("aCornerNdc");
    const aVoxelOffset = shader.attribute("aVoxelOffset");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    this.cornerBuffer.bindToVertexAttrib(
      aCornerNdc,
      2,
      gl.FLOAT,
      false,
      VERTEX_STRIDE_BYTES,
      NDC_OFFSET_BYTES,
    );
    this.cornerBuffer.bindToVertexAttrib(
      aVoxelOffset,
      3,
      gl.FLOAT,
      false,
      VERTEX_STRIDE_BYTES,
      VOXEL_OFFSET_BYTES,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, CORNER_COUNT);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(aCornerNdc);
    gl.disableVertexAttribArray(aVoxelOffset);
  }

  /** The painted-set test and the fill / outline appearance, for one draw. */
  private setFootprintUniforms(
    radiusSquared: number,
    anchorOffset: readonly [number, number],
  ): void {
    const { gl, shader } = this;
    gl.uniform1f(shader.uniform("uRadiusSquared"), radiusSquared);
    gl.uniform2f(
      shader.uniform("uAnchorOffset"),
      anchorOffset[0],
      anchorOffset[1],
    );
    gl.uniform1f(
      shader.uniform("uOutlineHalfWidthPixels"),
      OUTLINE_HALF_WIDTH_PIXELS,
    );
    gl.uniform1f(shader.uniform("uFillAlpha"), CURSOR_FILL_ALPHA);
    gl.uniform1f(shader.uniform("uOutlineAlpha"), CURSOR_OUTLINE_ALPHA);
  }

  /** Interleave the quad's NDC corners and voxel offsets into the vertex buffer. */
  private uploadQuad(
    cornersNdc: Float32Array,
    cornerVoxelOffsets: Float32Array,
  ): void {
    const { cornerData } = this;
    for (let corner = 0; corner < CORNER_COUNT; ++corner) {
      const vertex = corner * FLOATS_PER_CORNER;
      cornerData[vertex + 0] = cornersNdc[corner * 2 + 0];
      cornerData[vertex + 1] = cornersNdc[corner * 2 + 1];
      cornerData[vertex + 2] = cornerVoxelOffsets[corner * 3 + 0];
      cornerData[vertex + 3] = cornerVoxelOffsets[corner * 3 + 1];
      cornerData[vertex + 4] = cornerVoxelOffsets[corner * 3 + 2];
    }
    this.cornerBuffer.setData(cornerData, this.gl.DYNAMIC_DRAW);
  }
}

/**
 * Slice-view render layer that draws the brush / eraser footprint. Visibility,
 * radius, and the target resolution the footprint is quantized on all come from
 * `BrushCursorState`.
 */
export class BrushCursorSliceOverlay extends SliceViewPanelRenderLayer {
  // Topmost session visual: above ordinary layers and the region outline.
  override drawOrderPriority = 20;
  private renderer: PaintedFootprintRenderer;

  constructor(
    public gl: GL,
    public state: BrushCursorState,
  ) {
    super();
    this.renderer = this.registerDisposer(new PaintedFootprintRenderer(gl));

    // Trigger panel redraw on any cursor-state change.
    this.registerDisposer(
      state.visible.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      state.radiusVoxels.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      state.worldCenter.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      state.toolKind.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      state.targetResolution.changed.add(this.redrawNeeded.dispatch),
    );
  }

  override isReady(_renderContext: SliceViewPanelReadyRenderContext): boolean {
    return true;
  }

  override draw(renderContext: SliceViewPanelRenderContext): void {
    if (!renderContext.emitColor) return;
    const { state } = this;
    if (state.visible.value !== true) return;
    const worldCenter = state.worldCenter.value;
    if (worldCenter === undefined) return;
    const radiusVoxels = state.radiusVoxels.value;
    if (!Number.isFinite(radiusVoxels) || radiusVoxels < 0) return;

    const projectionParameters = renderContext.projectionParameters;
    const { width, height } = projectionParameters;
    const frame = resolveCursorVoxelFrame(
      state.targetResolution.value,
      projectionParameters.displayDimensionRenderInfo,
    );
    if (frame === undefined) return;

    // A brush size of 1 is radius 0 — a single voxel, not an empty footprint.
    const quad = computePaintedFootprintSliceQuad({
      radiusVoxels: brushRadius(radiusVoxels),
      worldCenter,
      frame,
      viewProjectionMat: projectionParameters.viewProjectionMat,
      invViewProjectionMat: projectionParameters.invViewProjectionMat,
      viewportWidth: width,
      viewportHeight: height,
      marginPixels: QUAD_MARGIN_PIXELS,
    });
    if (quad === undefined) return;

    this.renderer.draw(quad, brushRadiusSquared(radiusVoxels));
  }
}

/**
 * Footprint shader. Writes to BOTH slice-panel attachments (color + pickId)
 * because the panel's main draw loop binds both via
 * `sliceViewPanelEmitColorAndPickID`. Writing to only one attachment while both
 * are active triggers `GL_INVALID_OPERATION: Active draw buffers with missing
 * fragment shader outputs`. The cursor is non-pickable, so we emit a constant
 * zero pickId.
 *
 * The fragment stage is the whole cursor: it decides membership in the painted
 * set per fragment and derives the staircase outline from the same test, so no
 * per-voxel geometry is ever built on the CPU.
 */
export function buildFootprintShader(gl: GL): ShaderProgram {
  const builder = new ShaderBuilder(gl);
  builder.addAttribute("vec2", "aCornerNdc");
  builder.addAttribute("vec3", "aVoxelOffset");
  builder.addVarying("highp vec3", "vVoxelOffset");
  builder.addUniform("highp float", "uRadiusSquared");
  builder.addUniform("highp vec2", "uAnchorOffset");
  builder.addUniform("highp float", "uOutlineHalfWidthPixels");
  builder.addUniform("highp float", "uFillAlpha");
  builder.addUniform("highp float", "uOutlineAlpha");
  builder.addOutputBuffer("vec4", "out_fragColor", 0);
  builder.addOutputBuffer("highp vec4", "out_pickId", 1);
  builder.setVertexMain(`
vVoxelOffset = aVoxelOffset;
gl_Position = vec4(aCornerNdc, 0.0, 1.0);
`);
  // The disk the paint path stamps in the target grid's X/Y plane, one voxel
  // thick in Z — the same predicate `brushFootprintContains` states on the CPU.
  builder.addFragmentCode(glsl_brushFootprintContains);
  builder.setFragmentMain(`
vec3 voxelOffset = vVoxelOffset;
// Voxels traversed per pixel along each axis. The slice projection is affine,
// so these derivatives are constant across the quad — an exact scale factor,
// not an estimate. An axis running into the screen yields ~0, which turns into
// an effectively infinite distance below and drops its faces from the outline.
vec3 voxelsPerPixelX = dFdx(voxelOffset);
vec3 voxelsPerPixelY = dFdy(voxelOffset);
// Voxel index of this fragment, relative to the stamp anchor. The anchor is
// offset half a voxel for an even brush size, where the footprint straddles a
// voxel boundary rather than centring on a voxel.
vec3 cell = floor(voxelOffset);
vec3 fromAnchor = vec3(cell.xy - uAnchorOffset, cell.z);
bool inside = footprintContains(fromAnchor, uRadiusSquared);
float edgeDistancePixels = 1.0e6;
for (int axis = 0; axis < 3; ++axis) {
  float voxelsPerPixel =
      length(vec2(voxelsPerPixelX[axis], voxelsPerPixelY[axis]));
  if (voxelsPerPixel <= 0.0) continue;
  vec3 lowerNeighbor = fromAnchor;
  lowerNeighbor[axis] -= 1.0;
  vec3 upperNeighbor = fromAnchor;
  upperNeighbor[axis] += 1.0;
  if (footprintContains(lowerNeighbor, uRadiusSquared) != inside) {
    edgeDistancePixels = min(
        edgeDistancePixels, (voxelOffset[axis] - cell[axis]) / voxelsPerPixel);
  }
  if (footprintContains(upperNeighbor, uRadiusSquared) != inside) {
    edgeDistancePixels = min(
        edgeDistancePixels,
        (cell[axis] + 1.0 - voxelOffset[axis]) / voxelsPerPixel);
  }
}
float outlineCoverage = 1.0 - smoothstep(uOutlineHalfWidthPixels - 0.5,
                                         uOutlineHalfWidthPixels + 0.5,
                                         edgeDistancePixels);
float alpha = max(inside ? uFillAlpha : 0.0, outlineCoverage * uOutlineAlpha);
if (alpha <= 0.0) discard;
out_fragColor = vec4(1.0, 1.0, 1.0, alpha);
out_pickId = vec4(0.0, 0.0, 0.0, 1.0);
`);
  return builder.build();
}
