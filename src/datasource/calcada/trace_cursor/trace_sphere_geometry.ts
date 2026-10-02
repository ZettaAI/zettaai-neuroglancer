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
 * @file Pure geometry for the trace cursor sphere, kept free of GL and of
 * neuroglancer state so it can be tested directly.
 */

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { nanometresPerGlobalUnit } from "#src/datasource/calcada/global_nanometres.js";
import type { mat4 } from "#src/util/geom.js";
import { vec3, vec4 } from "#src/util/geom.js";

const SPHERE_STACKS = 16;
const SPHERE_SECTORS = 32;
// Every grid quad is two triangles of three vertices.
export const SPHERE_TRIANGLE_VERTEX_COUNT = SPHERE_STACKS * SPHERE_SECTORS * 6;

/**
 * Semi-axes of a ball of radius `radiusNm` expressed in global coordinates.
 *
 * Physically it is a ball; the coordinates are anisotropic, so in them it is an
 * ellipsoid. The same three numbers drive the sphere's model matrix and the
 * server-side filter, which is what keeps what is drawn and what is selected
 * from drifting apart — so they are derived here, once, from the coordinate
 * space rather than separately at each call site.
 */
export function traceSphereSemiAxes(
  radiusNm: number,
  coordinateSpace: CoordinateSpace,
): vec3 | undefined {
  const nmPerUnit = nanometresPerGlobalUnit(coordinateSpace);
  if (nmPerUnit === undefined) return undefined;
  return vec3.fromValues(
    radiusNm / nmPerUnit[0],
    radiusNm / nmPerUnit[1],
    radiusNm / nmPerUnit[2],
  );
}

/**
 * Whether a global-coordinate point lies inside the sphere, by the very test
 * the server filters with. Used to tell two very different failures apart: a
 * server that ignored the filter answers with everything outside, while a
 * server that applied it can still hand back an endpoint outside the sphere —
 * a candidate whose contact points coincide has both ends replaced by its
 * pieces' representative points, which lie wherever the pieces do.
 */
export function pointInsideSphere(
  point: ArrayLike<number>,
  center: ArrayLike<number>,
  semiAxes: ArrayLike<number>,
): boolean {
  let total = 0;
  for (let dim = 0; dim < 3; ++dim) {
    const normalized = (point[dim] - center[dim]) / semiAxes[dim];
    total += normalized * normalized;
  }
  return total <= 1;
}

export function buildUnitSphereTriangles(): Float32Array {
  const verts = new Float32Array(SPHERE_TRIANGLE_VERTEX_COUNT * 3);
  let off = 0;
  const point = (stack: number, sector: number) => {
    const phi = (stack / SPHERE_STACKS) * Math.PI;
    const theta = (sector / SPHERE_SECTORS) * 2 * Math.PI;
    verts[off++] = Math.sin(phi) * Math.cos(theta);
    verts[off++] = Math.sin(phi) * Math.sin(theta);
    verts[off++] = Math.cos(phi);
  };
  for (let stack = 0; stack < SPHERE_STACKS; ++stack) {
    for (let sector = 0; sector < SPHERE_SECTORS; ++sector) {
      point(stack, sector);
      point(stack + 1, sector);
      point(stack + 1, sector + 1);
      point(stack, sector);
      point(stack + 1, sector + 1);
      point(stack, sector + 1);
    }
  }
  return verts;
}

const CORNERS_NDC: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

export const SLICE_QUAD_CORNERS_NDC = Float32Array.from(CORNERS_NDC.flat());

/**
 * Global coordinates of the four corners of a full-viewport quad on the slice
 * plane. The slice projection is affine, so interpolating these four values
 * across the quad is exact — the fragment shader can evaluate the ellipsoid
 * test straight off it, which is what makes an oblique slice come out right
 * without any cross-section math.
 */
export function sliceQuadGlobalCorners(
  invViewProjectionMat: mat4,
): Float32Array {
  const out = new Float32Array(CORNERS_NDC.length * 3);
  const tmp = vec4.create();
  CORNERS_NDC.forEach(([x, y], i) => {
    vec4.set(tmp, x, y, 0, 1);
    vec4.transformMat4(tmp, tmp, invViewProjectionMat);
    out[i * 3 + 0] = tmp[0] / tmp[3];
    out[i * 3 + 1] = tmp[1] / tmp[3];
    out[i * 3 + 2] = tmp[2] / tmp[3];
  });
  return out;
}
