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
 * @file Where each piece of a segment is. The mesh manifest already lists a
 * bounding sphere per fragment, and a calcada fragment is one piece, so going
 * to a piece needs no graph query of its own.
 */

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { pieceIdOfFragment } from "#src/datasource/calcada/base.js";
import { nanometresPerGlobalUnit } from "#src/datasource/calcada/global_nanometres.js";

export interface PieceSphere {
  /** Nanometres. */
  center: readonly [number, number, number];
  radiusNm: number;
}

/**
 * Reads `fragments`, `frag_centers` and `frag_radii` from a mesh manifest.
 * A manifest without the spheres, or with lengths that disagree, yields
 * nothing rather than pieces placed at the wrong spot.
 */
export function parsePieceSpheres(manifest: unknown): Map<bigint, PieceSphere> {
  const spheres = new Map<bigint, PieceSphere>();
  const {
    fragments,
    frag_centers: centers,
    frag_radii: radii,
  } = (manifest ?? {}) as {
    fragments?: unknown;
    frag_centers?: unknown;
    frag_radii?: unknown;
  };
  if (
    !Array.isArray(fragments) ||
    !Array.isArray(centers) ||
    !Array.isArray(radii) ||
    centers.length !== 3 * fragments.length ||
    radii.length !== fragments.length
  ) {
    return spheres;
  }
  fragments.forEach((fragment, i) => {
    spheres.set(pieceIdOfFragment(String(fragment)), {
      center: [
        Number(centers[3 * i]),
        Number(centers[3 * i + 1]),
        Number(centers[3 * i + 2]),
      ],
      radiusNm: Number(radii[i]),
    });
  });
  return spheres;
}

/** A point in nanometres as global coordinates. */
export function nanometresToGlobal(
  pointNm: readonly number[],
  coordinateSpace: CoordinateSpace,
): Float32Array | undefined {
  const nmPerUnit = nanometresPerGlobalUnit(coordinateSpace);
  if (nmPerUnit === undefined) return undefined;
  const out = new Float32Array(coordinateSpace.rank);
  for (let dim = 0; dim < 3; ++dim) out[dim] = pointNm[dim] / nmPerUnit[dim];
  return out;
}
