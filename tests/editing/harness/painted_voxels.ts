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
 * The full set of voxels a page shows as painted (TM-331) — the read-back's
 * count/signature summary is enough to compare runs, but a test that knows the
 * exact expected set compares sets.
 */

import type { Page } from "@playwright/test";

import type { Vec3 } from "#tests/editing/harness/build_ng_state.js";

/**
 * Every voxel the page's session shows as painted on the target, from its
 * render mirror, in absolute coordinates: `"x,y,z"` → value.
 */
export async function paintedVoxelMap(
  page: Page,
  originOffset: Vec3,
): Promise<Map<string, string>> {
  const entries = (await page.evaluate(
    (offset) => {
      const host = (window as any).viewer.editSessionHost;
      const layerId = host.painting.state.getState().targetLayerId;
      const chunks = host.perLayer.get(layerId).patchStore.source.chunks;
      const out: Array<[string, string]> = [];
      for (const [key, chunk] of chunks) {
        const [gridX, gridY, gridZ] = String(key).split(",").map(Number);
        const [sizeX, sizeY, sizeZ] = chunk.chunkDataSize;
        for (let i = 0; i < chunk.patched.length; i++) {
          if (chunk.patched[i] === 0) continue;
          const x = gridX * sizeX + (i % sizeX) + offset[0];
          const y = gridY * sizeY + (Math.floor(i / sizeX) % sizeY) + offset[1];
          const z = gridZ * sizeZ + Math.floor(i / (sizeX * sizeY)) + offset[2];
          out.push([`${x},${y},${z}`, chunk.data[i].toString()]);
        }
      }
      return out;
    },
    [...originOffset],
  )) as Array<[string, string]>;
  return new Map(entries);
}
