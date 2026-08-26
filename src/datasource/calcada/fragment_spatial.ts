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

// Seam for converting manifest center units (nm) into mesh model-space
// units. Currently identity; change to 1 / resolution here if model space
// turns out not to be nm.
const NM_TO_MODEL_SCALE = 1;

type Category = "in" | "unknown" | "out";

function distanceTo(hint: FragmentSpatialHint, sphere: FragmentSphere): number {
  const dx = hint.focusModel[0] - sphere.cx;
  const dy = hint.focusModel[1] - sphere.cy;
  const dz = hint.focusModel[2] - sphere.cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isInFrustum(
  clippingPlanes: Float32Array,
  sphere: FragmentSphere,
): boolean {
  const { cx, cy, cz, r } = sphere;
  for (let i = 0; i < 6; ++i) {
    const a = clippingPlanes[4 * i];
    const b = clippingPlanes[4 * i + 1];
    const c = clippingPlanes[4 * i + 2];
    const d = clippingPlanes[4 * i + 3];
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

function classify(
  hint: FragmentSpatialHint,
  sphere: FragmentSphere,
): { category: Category; distance: number } {
  if (sphere.r < 0) {
    return { category: "unknown", distance: distanceTo(hint, sphere) };
  }
  const distance = distanceTo(hint, sphere);
  return {
    category: isInFrustum(hint.clippingPlanes, sphere) ? "in" : "out",
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
  private scoreCache: Map<string, number> | null = null;
  private biasCache: Map<string, number> | null = null;
  private dMax = 1;

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
        cx: centers[3 * i] * NM_TO_MODEL_SCALE,
        cy: centers[3 * i + 1] * NM_TO_MODEL_SCALE,
        cz: centers[3 * i + 2] * NM_TO_MODEL_SCALE,
        r: radii[i],
      });
    }
    this.invalidate();
  }

  updateHint(hint: FragmentSpatialHint | null): void {
    if (hintEquals(this.hint, hint)) return;
    this.hint = hint;
    this.invalidate();
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
    const classified = new Map<
      string,
      { category: Category; distance: number }
    >();
    for (const [id, sphere] of this.spheres) {
      const result = classify(hint, sphere);
      classified.set(id, result);
      if (result.category === "in") dMax = Math.max(dMax, result.distance);
    }
    this.dMax = dMax;
    for (const [id, result] of classified) {
      scoreCache.set(id, this.scoreFor(result));
      biasCache.set(id, this.biasFor(result));
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
