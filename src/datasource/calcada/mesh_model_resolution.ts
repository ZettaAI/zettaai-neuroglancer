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

import type { mat4 } from "#src/util/geom.js";

// A mesh can be generated at a coarser scale than the graph's base
// resolution (e.g. mesh_mip_1 for a graph built at mip 0); the mesh
// metadata's transform maps the graph's base-resolution voxel grid into the
// mesh's own voxel grid, so the graph's base resolution alone isn't the
// mesh's model-space resolution. This assumes an axis-aligned transform (no
// rotation/shear) — only the diagonal is used.
export function meshModelResolution(
  graphResolution: [number, number, number] | undefined,
  transform: mat4,
): [number, number, number] | undefined {
  if (graphResolution === undefined) return undefined;
  return [
    graphResolution[0] * transform[0],
    graphResolution[1] * transform[5],
    graphResolution[2] * transform[10],
  ];
}
