/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession, LayerId, Resolution } from "@zettaai/edit-session";

/**
 * The chunk size the session's buffers — overlay slots, and so the patch
 * mirror's chunks — use for `(layerId, resolution)`, from the session's own
 * metadata; `undefined` when the session does not have that layer or scale.
 *
 * It can be smaller than the NG source's nominal chunk (`editChunkDataSize`,
 * TM-373), so anything that sizes a patch chunk to hold session bytes must
 * take it from here, not from the NG source.
 */
export function sessionChunkDataSize(
  session: Pick<EditSession, "baseline">,
  layerId: LayerId,
  resolution: Resolution,
): readonly [number, number, number] | undefined {
  const scale = session.baseline.perLayer
    .get(layerId)
    ?.metadata.scales.find((candidate) => candidate.resolution === resolution);
  if (scale === undefined) return undefined;
  const [sizeX, sizeY, sizeZ] = scale.chunkDataSize;
  return [sizeX, sizeY, sizeZ];
}
