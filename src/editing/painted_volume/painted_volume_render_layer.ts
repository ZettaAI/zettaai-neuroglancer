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
 * @file Ray-marched painted-volume preview for the 3-D perspective panel.
 *
 * Draws the occupied texels as one smooth, opaque surface: where the linearly
 * filtered per-slice distance field crosses zero (one half, encoded), lit by
 * its gradient as a mesh is lit by its normals. Interpolating the field
 * between slices joins them in slopes (`painted_volume_distance_field.ts`). The geometry is only a proxy: the back faces
 * of the occupied box (front faces culled, so a camera inside the box still
 * gets fragments). Each fragment rebuilds its view ray from the inverse
 * model-view-projection, clips it to the box and walks it texel by texel
 * (Amanatides–Woo DDA), sampling the field twice per texel and bisecting
 * the first crossing; 8³ blocks with no occupied texel near them are crossed
 * in one step (`painted_volume_occupied_blocks.ts`), so the cost of a ray
 * follows what is painted along it rather than the size of the box. The
 * colour is the class of the nearest occupied texel inward from the surface. Working in texel indices, with the texel → display matrix folded
 * into the projection, makes anisotropic voxels come out right for free.
 *
 * The layer draws in the opaque pass and writes the hit's depth itself, so
 * meshes and slice planes occlude it — and are occluded by it — through the
 * ordinary depth test. It uses the panel's own `perspectivePanelEmit` and then
 * overwrites `out_z` with the hit depth, which the panel reads back for the 3-D
 * mouse position. Under the brush cursor, on the cursor's z, texels inside the
 * footprint are skipped, so the cursor drawn in that plane is not buried.
 */

import { PAINTED_VOLUME_DISTANCE_RANGE } from "#src/editing/painted_volume/painted_volume_distance_field.js";
import type { PaintedVolumeExtent } from "#src/editing/painted_volume/painted_volume_extent.js";
import type { PaintedVolumeFrameTimings } from "#src/editing/painted_volume/painted_volume_frame_cost.js";
import { PaintedVolumeFrameCost } from "#src/editing/painted_volume/painted_volume_frame_cost.js";
import { PAINTED_VOLUME_BLOCK_SIZE } from "#src/editing/painted_volume/painted_volume_occupied_blocks.js";
import { PaintedVolumeReducedMarch } from "#src/editing/painted_volume/painted_volume_reduced_march.js";
import type { PaintedVolumeResolution } from "#src/editing/painted_volume/painted_volume_resolution_governor.js";
import {
  PAINTED_VOLUME_FULL_RESOLUTION,
  PaintedVolumeResolutionGovernor,
} from "#src/editing/painted_volume/painted_volume_resolution_governor.js";
import { PAINTED_VOLUME_PALETTE_SIZE } from "#src/editing/painted_volume/painted_volume_segment_palette.js";
import type { TexelBox } from "#src/editing/painted_volume/painted_volume_texel_frame.js";
import type {
  PaintedVolumePaletteTexture,
  PaintedVolumeTexture,
} from "#src/editing/painted_volume/painted_volume_texture.js";
import { glsl_brushFootprintContains } from "#src/editing/tool_runtimes/brush_disk_footprint.js";
import type { PickState } from "#src/layer/index.js";
import { perspectivePanelEmit } from "#src/perspective_view/panel.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat3, mat4 } from "#src/util/geom.js";
import { glsl_getBoxFaceVertexPosition } from "#src/webgl/bounding_box.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

/** Brush footprint to keep clear, on the preview resolution's voxel grid. */
export interface PaintedVolumeCursorFootprint {
  /** `brushStampAnchor` of the pointer, in voxel indices of the preview resolution. */
  readonly anchorVoxel: readonly [number, number, number];
  /** `brushRadiusSquared` of the brush. */
  readonly radiusSquared: number;
}

/**
 * Everything the layer reads per frame. The preview controller owns these and
 * dispatches the layer's `redrawNeeded` when any of them changes.
 */
export interface PaintedVolumeRenderSource {
  readonly texture: PaintedVolumeTexture;
  readonly palette: PaintedVolumePaletteTexture;
  readonly extent: PaintedVolumeExtent;
  /** Texel → display (`buildTexelToDisplayMatrix`); `undefined` when not placeable. */
  readonly texelToDisplay: mat4 | undefined;
  /** Inclusive texel box holding every occupied texel; `undefined` = nothing to draw. */
  readonly occupiedBox: TexelBox | undefined;
  /** `undefined` while the cursor is hidden. */
  readonly cursorFootprint: PaintedVolumeCursorFootprint | undefined;
  /** `false` hides the layer, as a 3D opacity of 0 hides meshes. */
  readonly visible: boolean;
  /** The segment a texel class stands for; `undefined` when it has none. */
  segmentOfClass(segmentClass: number): bigint | undefined;
}

/** Per-frame view inputs, as the perspective panel provides them. */
export interface PaintedVolumeView {
  readonly viewProjectionMat: mat4;
  readonly lightDirection: ArrayLike<number>;
  readonly ambientLighting: number;
  readonly directionalLighting: number;
  /**
   * First of the 256 pick ids registered for this draw, one per texel class;
   * `0` writes no pick id.
   */
  readonly pickIdBase: number;
}

const OCCUPANCY_SAMPLER = Symbol("paintedVolumeOccupancy");
const DISTANCE_SAMPLER = Symbol("paintedVolumeDistance");
const PALETTE_SAMPLER = Symbol("paintedVolumePalette");
const BLOCKS_SAMPLER = Symbol("paintedVolumeBlocks");
const BOX_VERTEX_COUNT = 36;
/**
 * Steps per ray when the governor asks for the emergency cap: far surfaces
 * may be missing, but the frame is bounded on any GPU.
 */
export const PAINTED_VOLUME_EMERGENCY_MAX_STEPS = 256;

/** Adapt the march's resolution to what frames cost on this GPU. */
export interface PaintedVolumeAdaptiveOptions {
  /** The viewer's frame timer (`DisplayContext`). */
  readonly frameTimings: PaintedVolumeFrameTimings;
  /** The resolution to draw at changed: draw again. */
  readonly onResolutionChanged: () => void;
}

const glsl_cursorHidesTexel = `
// True when the cursor's footprint covers this texel on the cursor's z: the
// voxel of the texel's block nearest the anchor decides (exact at factor 1).
bool cursorHidesTexel(ivec3 texel) {
  if (!uCursorActive) return false;
  vec3 blockFirst = uTextureOrigin + vec3(texel) * uFactor;
  vec3 blockLast = blockFirst + uFactor - 1.0;
  vec3 nearest = clamp(floor(uCursorAnchorVoxel + 0.5), blockFirst, blockLast);
  return footprintContains(nearest - uCursorAnchorVoxel, uCursorRadiusSquared);
}
`;

const glsl_intersectOccupiedBox = `
// Ray parameters (tEnter, tExit) of the occupied box along origin + t * ray,
// and the axis whose face the ray enters through. Empty when tEnter > tExit.
vec2 intersectOccupiedBox(vec3 origin, vec3 ray, out int entryAxis) {
  float tEnter = -1.0e30;
  float tExit = 1.0e30;
  entryAxis = 0;
  for (int axis = 0; axis < 3; ++axis) {
    if (ray[axis] == 0.0) {
      if (origin[axis] < uBoxLo[axis] || origin[axis] > uBoxHi[axis]) {
        return vec2(1.0, 0.0);
      }
      continue;
    }
    float tLow = (uBoxLo[axis] - origin[axis]) / ray[axis];
    float tHigh = (uBoxHi[axis] - origin[axis]) / ray[axis];
    float slabEnter = min(tLow, tHigh);
    if (slabEnter > tEnter) {
      tEnter = slabEnter;
      entryAxis = axis;
    }
    tExit = min(tExit, max(tLow, tHigh));
  }
  return vec2(tEnter, tExit);
}
`;

const glsl_distance = `
// Interpolated encoded distance at a point in texel units (texel i spans
// [i, i + 1)): at or above one half is inside.
float distanceAt(vec3 point) {
  return texture(uDistance, point / uTextureSize).r;
}

// Ray parameter of the surface between tOutside (field below one half) and
// tInside (at or above it), by bisection: 10 halvings of at most half a texel
// put it within 1/2048 texel.
float refineCrossing(vec3 origin, vec3 ray, float tOutside, float tInside) {
  for (int i = 0; i < 10; ++i) {
    float tMiddle = 0.5 * (tOutside + tInside);
    if (distanceAt(origin + ray * tMiddle) >= 0.5) {
      tInside = tMiddle;
    } else {
      tOutside = tMiddle;
    }
  }
  return tInside;
}

// Outward surface normal in texel units: down the field's gradient, taken
// one texel either side and averaged over the four neighbours across each
// axis. A one-texel stencil would follow every voxel step of a stroke's edge
// and light it in stripes; this one smooths the normal as a mesh's averaged
// vertex normals do. Where the gradient vanishes, faces the ray.
float distanceDifference(vec3 point, vec3 along, vec3 acrossA, vec3 acrossB) {
  float difference = 0.0;
  for (int i = 0; i < 5; ++i) {
    vec3 offset = i == 0 ? vec3(0.0)
        : i == 1 ? acrossA
        : i == 2 ? -acrossA
        : i == 3 ? acrossB
        : -acrossB;
    difference += distanceAt(point + along + offset) -
        distanceAt(point - along + offset);
  }
  return difference;
}

vec3 surfaceNormal(vec3 point, vec3 ray) {
  const vec3 unitX = vec3(1.0, 0.0, 0.0);
  const vec3 unitY = vec3(0.0, 1.0, 0.0);
  const vec3 unitZ = vec3(0.0, 0.0, 1.0);
  vec3 gradient = vec3(distanceDifference(point, unitX, unitY, unitZ),
                       distanceDifference(point, unitY, unitX, unitZ),
                       distanceDifference(point, unitZ, unitX, unitY));
  if (dot(gradient, gradient) < 1.0e-8) return -ray;
  return -gradient;
}
`;

const glsl_shadeHit = `
// Lit colour (as the mesh shader lights), the hit's own depth, which
// replaces the proxy face's depth both in the depth buffer and in out_z, and
// the pick id of the segment's class, so hovering it picks the segment.
void shadeHit(vec3 rgb, uint segmentClass, vec3 texelNormal, vec3 hitPoint) {
  vec3 normal = normalize(uNormalToDisplay * texelNormal);
  float lighting = abs(dot(normal, uLightDirection.xyz)) + uLightDirection.w;
  vec4 hitClip = uModelViewProjection * vec4(hitPoint, 1.0);
  float depth = (hitClip.z / hitClip.w + 1.0) * 0.5;
  // The ray is not cut at the far plane (see the march), so cut the hit here.
  if (depth > 1.0) discard;
  gl_FragDepth = depth;
  uint pickId = uPickIdBase == 0u ? 0u : uPickIdBase + segmentClass;
  emit(vec4(rgb * lighting, 1.0), pickId);
  float zValue = 1.0 - depth;
  out_z = vec4(zValue, zValue, zValue, 1.0);
}

// The palette colour of a texel of segmentClass, unless it is empty, hidden
// or under the cursor window.
bool drawnColor(ivec3 texel, uint segmentClass, out vec3 rgb) {
  if (segmentClass == 0u || cursorHidesTexel(texel)) return false;
  vec4 color = texelFetch(uPalette, ivec2(int(segmentClass), 0), 0);
  rgb = color.rgb;
  return color.a != 0.0;
}

// Shade the surface at hitPoint and return true, unless its texel is empty,
// hidden or under the cursor window — then the march goes on.
bool shadeSurface(vec3 hitPoint, vec3 texelNormal, ivec3 firstTexel,
                  ivec3 lastTexel) {
  vec3 outward = normalize(texelNormal);
  // Between slices the surface can lie up to the distance range sideways from
  // the occupied texels it was morphed from: walk inward in half texels,
  // looking in both slices the point lies between.
  ivec3 texel = clamp(ivec3(floor(hitPoint)), firstTexel, lastTexel);
  uint segmentClass = texelFetch(uOccupancy, texel, 0).r;
  for (int step = 0; step <= 2 * ${PAINTED_VOLUME_DISTANCE_RANGE} + 1 &&
                     segmentClass == 0u;
       ++step) {
    vec3 point = hitPoint - outward * (0.5 * float(step));
    ivec3 below = ivec3(floor(point - vec3(0.0, 0.0, 0.5)));
    for (int layer = 0; layer < 2 && segmentClass == 0u; ++layer) {
      texel = clamp(below + ivec3(0, 0, layer), firstTexel, lastTexel);
      segmentClass = texelFetch(uOccupancy, texel, 0).r;
    }
  }
  vec3 rgb;
  if (!drawnColor(texel, segmentClass, rgb)) return false;
  shadeHit(rgb, segmentClass, texelNormal, hitPoint);
  return true;
}
`;

const glsl_blockSkip = `
const int BLOCK_SIZE = ${PAINTED_VOLUME_BLOCK_SIZE};

// False when no texel the field interpolates inside this texel's block is
// occupied: every sample there reads below one half.
bool blockMayHoldSurface(ivec3 texel) {
  return texelFetch(uOccupiedBlocks, texel / BLOCK_SIZE, 0).r != 0u;
}

// Ray parameter where the ray leaves the block holding texel, and the axis of
// the face it leaves through.
float blockExit(vec3 origin, vec3 ray, ivec3 texel, ivec3 stepDirection,
                out int exitAxis) {
  ivec3 blockFirst = (texel / BLOCK_SIZE) * BLOCK_SIZE;
  float tExit = 1.0e30;
  exitAxis = 0;
  for (int axis = 0; axis < 3; ++axis) {
    if (stepDirection[axis] == 0) continue;
    float face = float(stepDirection[axis] > 0 ? blockFirst[axis] + BLOCK_SIZE
                                               : blockFirst[axis]);
    float tFace = (face - origin[axis]) / ray[axis];
    if (tFace < tExit) {
      tExit = tFace;
      exitAxis = axis;
    }
  }
  return tExit;
}
`;

const glsl_marchMain = `
vec2 ndc = vClipPosition.xy / vClipPosition.w;
// The ray runs from the near plane through the point at NDC depth 0. The far
// plane (NDC depth 1) would be the usual second point, but with a large
// far / near ratio its unprojection loses all float precision, so t = 1 is
// not the far plane here: the march runs to the box exit instead.
vec4 nearHomogeneous = uInvModelViewProjection * vec4(ndc, -1.0, 1.0);
vec4 middleHomogeneous = uInvModelViewProjection * vec4(ndc, 0.0, 1.0);
vec3 nearPoint = nearHomogeneous.xyz / nearHomogeneous.w;
vec3 ray = middleHomogeneous.xyz / middleHomogeneous.w - nearPoint;

int entryAxis;
vec2 span = intersectOccupiedBox(nearPoint, ray, entryAxis);
float tStart = max(span.x, 0.0);
float tEnd = span.y;
if (tStart >= tEnd) discard;

ivec3 stepDirection = ivec3(sign(ray));
ivec3 firstTexel = ivec3(uBoxLo);
ivec3 lastTexel = ivec3(uBoxHi) - 1;
ivec3 texel = clamp(ivec3(floor(nearPoint + ray * tStart)), firstTexel, lastTexel);
if (span.x > 0.0) {
  // The start point lies on the entry face, where floor() is ambiguous: take
  // the texel just inside the face rather than nudging the point inward.
  texel[entryAxis] = stepDirection[entryAxis] > 0 ? firstTexel[entryAxis]
                                                  : lastTexel[entryAxis];
}

// Axis-aligned rays are the common case: a zero component never steps.
vec3 tDelta = vec3(1.0e30);
vec3 tNextBoundary = vec3(1.0e30);
for (int axis = 0; axis < 3; ++axis) {
  if (stepDirection[axis] == 0) continue;
  tDelta[axis] = abs(1.0 / ray[axis]);
  float boundary = float(texel[axis] + (stepDirection[axis] > 0 ? 1 : 0));
  tNextBoundary[axis] = (boundary - nearPoint[axis]) / ray[axis];
}

// The field is sampled at the middle and the far end of every texel the ray
// crosses, and where the ray crosses the texel's slice centre; the first rise
// past one half is bisected to the surface.
float tHit = tStart;
float tPrevious = tStart;
float distancePrevious = distanceAt(nearPoint + ray * tStart);
// Inside the surface the field cannot rise again, so when the ray starts
// inside it or passes a surface that is not drawn (cursor window, hidden
// class), each texel's own class decides until the ray leaves, drawn on the
// face it enters through, as its cube was.
bool insideUndrawn = false;
vec3 cellNormal = -ray;
if (distancePrevious >= 0.5) {
  if (span.x > 0.0) {
    // The surface is cut by the box face itself.
    cellNormal = vec3(0.0);
    cellNormal[entryAxis] = -float(stepDirection[entryAxis]);
    if (shadeSurface(nearPoint + ray * tStart, cellNormal, firstTexel,
                     lastTexel)) {
      return;
    }
  }
  insideUndrawn = true;
}
// The block whose flag was read last; its flag is read once per block entered.
ivec3 flagBlock = ivec3(-1);
bool flagMayHoldSurface = true;
for (int i = 0; i < uMaxSteps; ++i) {
  if (texel / BLOCK_SIZE != flagBlock) {
    flagBlock = texel / BLOCK_SIZE;
    flagMayHoldSurface = blockMayHoldSurface(texel);
  }
  if (!flagMayHoldSurface) {
    // As if marched texel by texel: every sample read below one half, the
    // last one where the ray leaves the block.
    int exitAxis;
    float tExit = blockExit(nearPoint, ray, texel, stepDirection, exitAxis);
    insideUndrawn = false;
    distancePrevious = 0.0;
    tPrevious = min(tExit, tEnd);
    tHit = tExit;
    if (tHit > tEnd) break;
    ivec3 blockFirst = (texel / BLOCK_SIZE) * BLOCK_SIZE;
    ivec3 blockLast = blockFirst + (BLOCK_SIZE - 1);
    // Off the exit axis the exit point is inside the block; clamp away the
    // rounding of floor() on a face.
    texel = clamp(ivec3(floor(nearPoint + ray * tHit)), blockFirst, blockLast);
    texel[exitAxis] = stepDirection[exitAxis] > 0 ? blockLast[exitAxis] + 1
                                                  : blockFirst[exitAxis] - 1;
    if (any(lessThan(texel, firstTexel)) || any(greaterThan(texel, lastTexel))) {
      break;
    }
    for (int axis = 0; axis < 3; ++axis) {
      if (stepDirection[axis] == 0) continue;
      float boundary = float(texel[axis] + (stepDirection[axis] > 0 ? 1 : 0));
      tNextBoundary[axis] = (boundary - nearPoint[axis]) / ray[axis];
    }
    cellNormal = vec3(0.0);
    cellNormal[exitAxis] = -float(stepDirection[exitAxis]);
    continue;
  }
  if (insideUndrawn) {
    vec3 rgb;
    uint segmentClass = texelFetch(uOccupancy, texel, 0).r;
    if (drawnColor(texel, segmentClass, rgb)) {
      shadeHit(rgb, segmentClass, cellNormal, nearPoint + ray * tHit);
      return;
    }
  }
  float tCellEnd = min(min(tNextBoundary.x, tNextBoundary.y), tNextBoundary.z);
  tCellEnd = min(tCellEnd, tEnd);
  // A one-slice stroke's rim is a lens a fraction of a texel thick around
  // the slice centre, where the field peaks in z: an oblique ray sampled
  // only at the middle and the end of the texel steps over it.
  float tMiddle = 0.5 * (tHit + tCellEnd);
  float tSliceCentre = ray.z == 0.0
      ? -1.0
      : (float(texel.z) + 0.5 - nearPoint.z) / ray.z;
  bool crossesSliceCentre = tSliceCentre > tHit && tSliceCentre < tCellEnd;
  for (int sampleIndex = 0; sampleIndex < 3; ++sampleIndex) {
    float t;
    if (sampleIndex == 2) {
      t = tCellEnd;
    } else if (crossesSliceCentre) {
      t = sampleIndex == 0 ? min(tMiddle, tSliceCentre)
                           : max(tMiddle, tSliceCentre);
    } else if (sampleIndex == 0) {
      t = tMiddle;
    } else {
      continue;
    }
    float distance = distanceAt(nearPoint + ray * t);
    if (distance >= 0.5 && distancePrevious < 0.5) {
      float tSurface = refineCrossing(nearPoint, ray, tPrevious, t);
      vec3 hitPoint = nearPoint + ray * tSurface;
      if (shadeSurface(hitPoint, surfaceNormal(hitPoint, ray), firstTexel,
                       lastTexel)) {
        return;
      }
      insideUndrawn = true;
    } else if (distance < 0.5) {
      insideUndrawn = false;
    }
    tPrevious = t;
    distancePrevious = distance;
  }
  int axis = tNextBoundary.x < tNextBoundary.y
      ? (tNextBoundary.x < tNextBoundary.z ? 0 : 2)
      : (tNextBoundary.y < tNextBoundary.z ? 1 : 2);
  tHit = tNextBoundary[axis];
  if (tHit > tEnd) break;
  texel[axis] += stepDirection[axis];
  if (texel[axis] < firstTexel[axis] || texel[axis] > lastTexel[axis]) break;
  tNextBoundary[axis] += tDelta[axis];
  cellNormal = vec3(0.0);
  cellNormal[axis] = -float(stepDirection[axis]);
}
discard;
`;

/** The preview shader: one static program, bound to the panel's emitter. */
export function buildPaintedVolumeShader(gl: GL): ShaderProgram {
  const builder = new ShaderBuilder(gl);
  defineVertexId(builder);
  builder.addTextureSampler("usampler3D", "uOccupancy", OCCUPANCY_SAMPLER);
  builder.addTextureSampler("sampler3D", "uDistance", DISTANCE_SAMPLER);
  builder.addTextureSampler("sampler2D", "uPalette", PALETTE_SAMPLER);
  builder.addTextureSampler("usampler3D", "uOccupiedBlocks", BLOCKS_SAMPLER);
  builder.addUniform("highp mat4", "uModelViewProjection");
  builder.addUniform("highp mat4", "uInvModelViewProjection");
  builder.addUniform("highp mat3", "uNormalToDisplay");
  builder.addUniform("highp vec3", "uBoxLo");
  builder.addUniform("highp vec3", "uBoxHi");
  builder.addUniform("highp vec4", "uLightDirection");
  builder.addUniform("highp int", "uMaxSteps");
  builder.addUniform("highp vec3", "uTextureOrigin");
  builder.addUniform("highp vec3", "uTextureSize");
  builder.addUniform("highp vec3", "uFactor");
  builder.addUniform("bool", "uCursorActive");
  builder.addUniform("highp vec3", "uCursorAnchorVoxel");
  builder.addUniform("highp float", "uCursorRadiusSquared");
  builder.addUniform("highp uint", "uPickIdBase");
  builder.addVarying("highp vec4", "vClipPosition");
  builder.addVertexCode(glsl_getBoxFaceVertexPosition);
  builder.setVertexMain(`
vec3 position = mix(uBoxLo, uBoxHi, getBoxFaceVertexPosition(gl_VertexID));
vClipPosition = uModelViewProjection * vec4(position, 1.0);
gl_Position = vClipPosition;
// Never clip the proxy at the near or far plane; the real depth is written
// per fragment.
gl_Position.z = 0.0;
`);
  perspectivePanelEmit(builder);
  builder.addFragmentCode(glsl_brushFootprintContains);
  builder.addFragmentCode(glsl_cursorHidesTexel);
  builder.addFragmentCode(glsl_intersectOccupiedBox);
  builder.addFragmentCode(glsl_distance);
  builder.addFragmentCode(glsl_shadeHit);
  builder.addFragmentCode(glsl_blockSkip);
  builder.setFragmentMain(glsl_marchMain);
  return builder.build();
}

/** Owns the shader and issues the draw; independent of the panel for tests. */
export class PaintedVolumeRenderer extends RefCounted {
  private readonly shader: ShaderProgram;
  private readonly vertexIdHelper: VertexIdHelper;
  private readonly modelViewProjection = mat4.create();
  private readonly invModelViewProjection = mat4.create();
  private readonly normalToDisplay = mat3.create();

  private readonly governor: PaintedVolumeResolutionGovernor | undefined;
  private readonly frameCost: PaintedVolumeFrameCost | undefined;
  private readonly reducedMarch: PaintedVolumeReducedMarch | undefined;
  /** Uncapped steps over the steps the current draw allows. */
  private stepFactor = 1;

  /**
   * Without `adaptive` every frame marches at full resolution; with it, the
   * resolution follows the measured frame cost
   * (`painted_volume_resolution_governor.ts`). A browser without a GPU timer
   * measures nothing, so it stays at full resolution as before.
   */
  constructor(
    private readonly gl: GL,
    adaptive?: PaintedVolumeAdaptiveOptions,
  ) {
    super();
    this.shader = buildPaintedVolumeShader(gl);
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(gl));
    if (adaptive === undefined || !adaptive.frameTimings.measuresFrameTimes) {
      return;
    }
    const governor = new PaintedVolumeResolutionGovernor();
    this.governor = governor;
    this.frameCost = new PaintedVolumeFrameCost(
      adaptive.frameTimings,
      governor,
      adaptive.onResolutionChanged,
    );
    this.reducedMarch = this.registerDisposer(
      new PaintedVolumeReducedMarch(gl),
    );
  }

  /** The resolution the next frame marches at. */
  get resolution(): PaintedVolumeResolution {
    return this.governor?.resolution ?? PAINTED_VOLUME_FULL_RESOLUTION;
  }

  /** Whether the resolution follows the measured cost. */
  get adaptive(): boolean {
    return this.governor !== undefined;
  }

  /** The latest measured frame time, when adapting; for diagnostics. */
  get lastFrameMilliseconds(): number | undefined {
    return this.frameCost?.lastFrameMilliseconds;
  }

  /** Draw into the bound framebuffer; GL state it changes is restored. */
  draw(source: PaintedVolumeRenderSource, view: PaintedVolumeView): void {
    const { occupiedBox, texelToDisplay } = source;
    if (!source.visible) return;
    if (occupiedBox === undefined || texelToDisplay === undefined) return;
    if (source.texture.texture === undefined) return;
    const { gl, shader } = this;
    if (!this.computeMatrices(texelToDisplay, view.viewProjectionMat)) return;

    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const { resolution } = this;
    const march = () => {
      shader.bind();
      source.texture.bind(shader.textureUnit(OCCUPANCY_SAMPLER));
      source.texture.bindDistance(shader.textureUnit(DISTANCE_SAMPLER));
      source.palette.bind(shader.textureUnit(PALETTE_SAMPLER));
      source.texture.bindBlocks(shader.textureUnit(BLOCKS_SAMPLER));
      this.setViewUniforms(view);
      this.setVolumeUniforms(source, occupiedBox, resolution.capSteps);
      this.setCursorUniforms(source.cursorFootprint);
      this.drawProxyBox(resolution);
    };
    if (resolution.reduction === 1 || this.reducedMarch === undefined) {
      march();
    } else {
      this.reducedMarch.draw(resolution.reduction, march);
    }
    gl.activeTexture(previousActiveTexture);
  }

  /** The march's one draw call; culling is restored. */
  private drawProxyBox(resolution: PaintedVolumeResolution): void {
    const { gl } = this;
    const cullFaceWasEnabled = gl.isEnabled(gl.CULL_FACE);
    const previousCullFaceMode = gl.getParameter(gl.CULL_FACE_MODE) as number;
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    this.vertexIdHelper.enable();
    gl.drawArrays(gl.TRIANGLES, 0, BOX_VERTEX_COUNT);
    this.frameCost?.noteDraw(resolution, this.stepFactor);
    this.vertexIdHelper.disable();
    gl.cullFace(previousCullFaceMode);
    if (!cullFaceWasEnabled) gl.disable(gl.CULL_FACE);
  }

  override disposed(): void {
    this.frameCost?.dispose();
    this.shader.dispose();
    super.disposed();
  }

  /** False when the combined matrix is singular (degenerate view). */
  private computeMatrices(texelToDisplay: mat4, viewProjection: mat4) {
    mat4.multiply(this.modelViewProjection, viewProjection, texelToDisplay);
    if (mat4.invert(this.invModelViewProjection, this.modelViewProjection)) {
      return mat3.normalFromMat4(this.normalToDisplay, texelToDisplay) !== null;
    }
    return false;
  }

  private setViewUniforms(view: PaintedVolumeView): void {
    const { gl, shader } = this;
    const { lightDirection, directionalLighting } = view;
    gl.uniformMatrix4fv(
      shader.uniform("uModelViewProjection"),
      false,
      this.modelViewProjection,
    );
    gl.uniformMatrix4fv(
      shader.uniform("uInvModelViewProjection"),
      false,
      this.invModelViewProjection,
    );
    gl.uniformMatrix3fv(
      shader.uniform("uNormalToDisplay"),
      false,
      this.normalToDisplay,
    );
    gl.uniform4f(
      shader.uniform("uLightDirection"),
      lightDirection[0] * directionalLighting,
      lightDirection[1] * directionalLighting,
      lightDirection[2] * directionalLighting,
      view.ambientLighting,
    );
    gl.uniform1ui(shader.uniform("uPickIdBase"), view.pickIdBase);
  }

  private setVolumeUniforms(
    source: PaintedVolumeRenderSource,
    occupiedBox: TexelBox,
    capSteps: boolean,
  ): void {
    const { gl, shader } = this;
    const { textureOrigin, factor, textureSize } = source.extent;
    gl.uniform3f(
      shader.uniform("uBoxLo"),
      occupiedBox.x0,
      occupiedBox.y0,
      occupiedBox.z0,
    );
    gl.uniform3f(
      shader.uniform("uBoxHi"),
      occupiedBox.x1 + 1,
      occupiedBox.y1 + 1,
      occupiedBox.z1 + 1,
    );
    // A ray crosses at most one boundary per texel along each axis.
    const [sizeX, sizeY, sizeZ] = textureSize;
    gl.uniform3f(shader.uniform("uTextureSize"), sizeX, sizeY, sizeZ);
    const stepsToCrossTexture = sizeX + sizeY + sizeZ + 3;
    const allowedSteps = capSteps
      ? Math.min(stepsToCrossTexture, PAINTED_VOLUME_EMERGENCY_MAX_STEPS)
      : stepsToCrossTexture;
    this.stepFactor = stepsToCrossTexture / allowedSteps;
    gl.uniform1i(shader.uniform("uMaxSteps"), allowedSteps);
    gl.uniform3f(
      shader.uniform("uTextureOrigin"),
      textureOrigin[0],
      textureOrigin[1],
      textureOrigin[2],
    );
    gl.uniform3f(shader.uniform("uFactor"), factor[0], factor[1], factor[2]);
  }

  private setCursorUniforms(
    footprint: PaintedVolumeCursorFootprint | undefined,
  ): void {
    const { gl, shader } = this;
    gl.uniform1i(shader.uniform("uCursorActive"), footprint ? 1 : 0);
    if (footprint === undefined) return;
    const [anchorX, anchorY, anchorZ] = footprint.anchorVoxel;
    gl.uniform3f(
      shader.uniform("uCursorAnchorVoxel"),
      anchorX,
      anchorY,
      anchorZ,
    );
    gl.uniform1f(
      shader.uniform("uCursorRadiusSquared"),
      footprint.radiusSquared,
    );
  }
}

/**
 * The preview as a perspective-panel layer. Opaque, never blocks the panel's
 * "ready" state, and draws the same in wireframe mode (§3.11 of the plan).
 */
export class PaintedVolumeRenderLayer extends PerspectiveViewRenderLayer {
  private readonly renderer: PaintedVolumeRenderer;

  /** With `frameTimings`, the resolution adapts to the GPU's frame cost. */
  constructor(
    gl: GL,
    private readonly source: PaintedVolumeRenderSource,
    frameTimings?: PaintedVolumeFrameTimings,
  ) {
    super();
    this.renderer = this.registerDisposer(
      new PaintedVolumeRenderer(
        gl,
        frameTimings === undefined
          ? undefined
          : {
              frameTimings,
              onResolutionChanged: () => this.redrawNeeded.dispatch(),
            },
      ),
    );
  }

  /** The resolution the preview marches at now; for diagnostics and tests. */
  get resolution(): PaintedVolumeResolution {
    return this.renderer.resolution;
  }

  get adaptive(): boolean {
    return this.renderer.adaptive;
  }

  get lastFrameMilliseconds(): number | undefined {
    return this.renderer.lastFrameMilliseconds;
  }

  get isTransparent() {
    return false;
  }

  override isReady(): boolean {
    return true;
  }

  override draw(renderContext: PerspectiveViewRenderContext): void {
    // Only the opaque colour pass; the shader is built for this emitter alone.
    if (!renderContext.emitColor) return;
    if (renderContext.emitter !== perspectivePanelEmit) return;
    this.renderer.draw(this.source, {
      pickIdBase: renderContext.emitPickID
        ? renderContext.pickIDs.register(this, PAINTED_VOLUME_PALETTE_SIZE)
        : 0,
      viewProjectionMat: renderContext.projectionParameters.viewProjectionMat,
      lightDirection: renderContext.lightDirection,
      ambientLighting: renderContext.ambientLighting,
      directionalLighting: renderContext.directionalLighting,
    });
  }

  /** The segment of the picked texel class, as a mesh pick yields its object. */
  override transformPickedValue(pickState: PickState): bigint | undefined {
    return this.source.segmentOfClass(pickState.pickedOffset);
  }
}
