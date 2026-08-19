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

// LOD 0 is the finest level in calcada's multilod manifest format (confirmed
// against multilod_mesh.ts: `decodeMultilodPieceMesh` scales fragment
// geometry by `2 ** targetLod`, so LOD 0 applies no extra coarsening and
// higher indices are progressively coarser, up to numLods - 1).
export function selectLodForPieceCount(
  pieceCount: number,
  numLods: number,
): number {
  if (numLods <= 1) return 0;
  const steps =
    pieceCount <= 50 ? 0 : Math.floor(Math.log2(pieceCount / 50)) + 1;
  return Math.min(steps, numLods - 1);
}
