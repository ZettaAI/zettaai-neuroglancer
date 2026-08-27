/**
 * @license
 * Copyright 2024 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { FragmentSpatialHint } from "#src/mesh/backend.js";

export interface FragmentSphere {
  cx: number;
  cy: number;
  cz: number;
  r: number;
}

const UNKNOWN_SCORE = Number.MAX_SAFE_INTEGER / 2;
const OUT_OF_VIEW_OFFSET = Number.MAX_SAFE_INTEGER;

export type Resolution = readonly [number, number, number];

const IDENTITY_RESOLUTION: Resolution = [1, 1, 1];

// Falls back to [1, 1, 1] (nm treated as model units) when the caller has no
// resolution, or any axis isn't a finite positive number.
function normalizeResolution(resolution: Resolution | undefined): Resolution {
  if (
    resolution === undefined ||
    resolution.length !== 3 ||
    resolution.some((v) => !(Number.isFinite(v) && v > 0))
  ) {
    return IDENTITY_RESOLUTION;
  }
  return resolution;
}

type Category = "in" | "unknown" | "out";

// Piece centers/radii are stored in nm (see FragmentSphere); focusModel and
// clippingPlanes are in the mesh's MODEL space, which is voxels at the
// graph's base resolution, not necessarily nm. Distance is computed in nm
// (physically correct, avoids anisotropic z distortion) by converting the
// focus into nm; the frustum test is done in model space (matching the
// planes) by converting the sphere into model units.
function distanceTo(
  hint: FragmentSpatialHint,
  sphere: FragmentSphere,
  resolution: Resolution,
): number {
  const dx = hint.focusModel[0] * resolution[0] - sphere.cx;
  const dy = hint.focusModel[1] * resolution[1] - sphere.cy;
  const dz = hint.focusModel[2] * resolution[2] - sphere.cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// getFrustrumPlanes returns non-unit normals, so the raw plane equation is a
// distance scaled by |(a, b, c)| — unusable against a radius until
// normalized. A degenerate plane (zero normal) is made to never reject.
function normalizePlanes(clippingPlanes: Float32Array): Float32Array {
  const normalized = new Float32Array(24);
  for (let i = 0; i < 6; ++i) {
    const a = clippingPlanes[4 * i];
    const b = clippingPlanes[4 * i + 1];
    const c = clippingPlanes[4 * i + 2];
    const d = clippingPlanes[4 * i + 3];
    const length = Math.sqrt(a * a + b * b + c * c);
    if (!(length > 0) || !Number.isFinite(length)) {
      normalized[4 * i] = 0;
      normalized[4 * i + 1] = 0;
      normalized[4 * i + 2] = 0;
      normalized[4 * i + 3] = Number.MAX_VALUE;
      continue;
    }
    normalized[4 * i] = a / length;
    normalized[4 * i + 1] = b / length;
    normalized[4 * i + 2] = c / length;
    normalized[4 * i + 3] = d / length;
  }
  return normalized;
}

function isInFrustum(
  normalizedPlanes: Float32Array,
  sphere: FragmentSphere,
  resolution: Resolution,
): boolean {
  const cx = sphere.cx / resolution[0];
  const cy = sphere.cy / resolution[1];
  const cz = sphere.cz / resolution[2];
  // Dividing by the smallest axis resolution over-estimates the model-space
  // radius on the other axes, so an edge piece stays classified in-frustum
  // rather than incorrectly deferred.
  const r = sphere.r / Math.min(resolution[0], resolution[1], resolution[2]);
  for (let i = 0; i < 6; ++i) {
    const a = normalizedPlanes[4 * i];
    const b = normalizedPlanes[4 * i + 1];
    const c = normalizedPlanes[4 * i + 2];
    const d = normalizedPlanes[4 * i + 3];
    if (a * cx + b * cy + c * cz + d < -r) return false;
  }
  return true;
}

// True when two hints carry the same view (same clipping planes and focus),
// regardless of object identity. Lets updateHint skip the O(all-pieces)
// reclassification pass on a recomputeChunkPriorities tick that didn't
// actually move the camera or load new manifest data.
function hintEquals(
  a: FragmentSpatialHint | null,
  b: FragmentSpatialHint | null,
): boolean {
  if (a === null || b === null) return a === b;
  for (let i = 0; i < 24; ++i) {
    if (a.clippingPlanes[i] !== b.clippingPlanes[i]) return false;
  }
  for (let i = 0; i < 3; ++i) {
    if (a.focusModel[i] !== b.focusModel[i]) return false;
  }
  return true;
}

function hintIsFinite(hint: FragmentSpatialHint): boolean {
  for (let i = 0; i < 24; ++i) {
    if (!Number.isFinite(hint.clippingPlanes[i])) return false;
  }
  for (let i = 0; i < 3; ++i) {
    if (!Number.isFinite(hint.focusModel[i])) return false;
  }
  return true;
}

function classify(
  hint: FragmentSpatialHint,
  normalizedPlanes: Float32Array,
  sphere: FragmentSphere,
  resolution: Resolution,
): { category: Category; distance: number } {
  if (sphere.r < 0) {
    return {
      category: "unknown",
      distance: distanceTo(hint, sphere, resolution),
    };
  }
  const distance = distanceTo(hint, sphere, resolution);
  return {
    category: isInFrustum(normalizedPlanes, sphere, resolution) ? "in" : "out",
    distance,
  };
}

/**
 * Scores mesh fragments (pieces) by proximity to the current view so nearer,
 * in-frustum pieces load before distant or off-screen ones. Scores and
 * priority biases are cached per fragment id and invalidated whenever the
 * view hint or the known sphere set changes.
 */
export class FragmentSpatialIndex {
  private spheres = new Map<string, FragmentSphere>();
  private hint: FragmentSpatialHint | null = null;
  private resolution: Resolution;
  private scoreCache: Map<string, number> | null = null;
  private biasCache: Map<string, number> | null = null;
  private outOfViewCache = new Set<string>();
  private dMax = 1;

  // resolution is the mesh's own voxel model-space resolution (nm/voxel per
  // axis) — NOT necessarily the graph's base resolution, since a mesh can be
  // generated at a coarser mip (see mesh_model_resolution.ts). Used to
  // convert between the nm centers parsed from the manifest and that model
  // space. Invalid input (see normalizeResolution) falls back to [1, 1, 1].
  constructor(resolution?: Resolution) {
    this.resolution = normalizeResolution(resolution);
  }

  setFromManifest(
    fragments: string[],
    centers: number[] | undefined,
    radii: number[] | undefined,
  ): void {
    if (!Array.isArray(centers) || !Array.isArray(radii)) return;
    if (
      centers.length !== 3 * fragments.length ||
      radii.length !== fragments.length
    ) {
      return;
    }
    for (let i = 0; i < fragments.length; ++i) {
      this.spheres.set(fragments[i], {
        cx: centers[3 * i],
        cy: centers[3 * i + 1],
        cz: centers[3 * i + 2],
        r: radii[i],
      });
    }
    this.invalidate();
  }

  // Returns whether the hint actually changed. A non-finite hint (degenerate
  // camera during a navigation transient) is ignored — it can't reject
  // anything, so accepting it would flush the deferred pool for one broken
  // frame.
  updateHint(hint: FragmentSpatialHint | null): boolean {
    if (hint !== null && !hintIsFinite(hint)) return false;
    if (hintEquals(this.hint, hint)) return false;
    this.hint = hint;
    this.invalidate();
    return true;
  }

  score(fragmentId: string): number {
    this.ensureCache();
    return this.scoreCache!.get(fragmentId) ?? this.fill(fragmentId).score;
  }

  priorityBias(fragmentId: string): number {
    this.ensureCache();
    return this.biasCache!.get(fragmentId) ?? this.fill(fragmentId).bias;
  }

  compare(a: string, b: string): number {
    return this.score(a) - this.score(b);
  }

  // True only for a known-bounds piece fully outside the frustum;
  // unknown-bounds, never-seen, and no-hint cases report false so a piece
  // that might be visible is never culled.
  isOutOfView(fragmentId: string): boolean {
    this.ensureCache();
    return this.outOfViewCache.has(fragmentId);
  }

  private invalidate() {
    this.scoreCache = null;
    this.biasCache = null;
  }

  private ensureCache() {
    if (this.scoreCache !== null) return;
    const scoreCache = new Map<string, number>();
    const biasCache = new Map<string, number>();
    this.scoreCache = scoreCache;
    this.biasCache = biasCache;
    this.outOfViewCache = new Set();
    const { hint } = this;
    if (hint === null) {
      for (const id of this.spheres.keys()) {
        scoreCache.set(id, 0);
        biasCache.set(id, 0);
      }
      this.dMax = 1;
      return;
    }
    let dMax = 1;
    const normalizedPlanes = normalizePlanes(hint.clippingPlanes);
    const classified = new Map<
      string,
      { category: Category; distance: number }
    >();
    for (const [id, sphere] of this.spheres) {
      const result = classify(hint, normalizedPlanes, sphere, this.resolution);
      classified.set(id, result);
      if (result.category === "in") dMax = Math.max(dMax, result.distance);
    }
    this.dMax = dMax;
    for (const [id, result] of classified) {
      scoreCache.set(id, this.scoreFor(result));
      biasCache.set(id, this.biasFor(result));
      if (result.category === "out") this.outOfViewCache.add(id);
    }
  }

  // Computes and caches score/bias for a fragment id with no known sphere
  // (server sent no centers for it, or it arrived after the last cache
  // fill). Score matches known-unknown-bounds pieces (mid-pack pool order),
  // but bias stays 0 — no server info means no priority penalty, so sources
  // without spatial data keep today's queue behavior exactly.
  private fill(fragmentId: string): { score: number; bias: number } {
    const result =
      this.hint === null
        ? { score: 0, bias: 0 }
        : { score: UNKNOWN_SCORE, bias: 0 };
    this.scoreCache!.set(fragmentId, result.score);
    this.biasCache!.set(fragmentId, result.bias);
    return result;
  }

  private scoreFor(result: { category: Category; distance: number }): number {
    switch (result.category) {
      case "in":
        return result.distance;
      case "unknown":
        return UNKNOWN_SCORE;
      case "out":
        return OUT_OF_VIEW_OFFSET + result.distance;
    }
  }

  private biasFor(result: { category: Category; distance: number }): number {
    switch (result.category) {
      case "in":
        return -0.5 * Math.min(Math.max(result.distance / this.dMax, 0), 1);
      case "unknown":
        return -0.75;
      case "out":
        return -1;
    }
  }
}
