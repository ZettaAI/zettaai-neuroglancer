/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { vec3 } from "#src/util/geom.js";

/**
 * Nanometres per global coordinate unit along x, y and z. Scales are SI when a
 * unit is given; a unitless space is already in nanometres as far as calcada
 * is concerned. Undefined when the space cannot say.
 */
export function nanometresPerGlobalUnit(
  coordinateSpace: CoordinateSpace,
): vec3 | undefined {
  if (!coordinateSpace.valid || coordinateSpace.rank < 3) return undefined;
  const out = vec3.create();
  for (let dim = 0; dim < 3; ++dim) {
    const scale = coordinateSpace.scales[dim];
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    out[dim] = coordinateSpace.units[dim] === "m" ? scale * 1e9 : scale;
  }
  return out;
}
