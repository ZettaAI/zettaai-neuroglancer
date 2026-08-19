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

import { packColor } from "#src/util/color.js";
import { vec4 } from "#src/util/geom.js";

export const TRACE_SEED_RGB = vec4.fromValues(1.0, 0.84, 0.0, 1.0);
export const TRACE_CANDIDATE_RGB = vec4.fromValues(0.75, 0.75, 0.78, 1.0);
export const TRACE_SEED_DIM_RGB = vec4.fromValues(1.0, 0.84, 0.0, 0.15);
export const TRACE_CANDIDATE_DIM_RGB = vec4.fromValues(0.75, 0.75, 0.78, 0.15);

export function packRoleColor(rgba: vec4): bigint {
  return BigInt(packColor(rgba));
}

export const TRACE_SEED_COLOR_PACKED = packRoleColor(TRACE_SEED_RGB);
export const TRACE_CANDIDATE_COLOR_PACKED = packRoleColor(TRACE_CANDIDATE_RGB);
export const TRACE_SEED_DIM_COLOR_PACKED = packRoleColor(TRACE_SEED_DIM_RGB);
export const TRACE_CANDIDATE_DIM_COLOR_PACKED = packRoleColor(
  TRACE_CANDIDATE_DIM_RGB,
);

export function interceptedRemovals(
  removedIds: readonly bigint[],
  roleRoots: ReadonlySet<bigint>,
): bigint[] {
  return removedIds.filter((id) => roleRoots.has(id));
}
