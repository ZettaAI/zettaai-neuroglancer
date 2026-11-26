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
 * Every voxel the page's session shows as painted on the target, in absolute
 * coordinates of the level of `resolution` (default: the Target resolution):
 * `"x,y,z"` → value. With edits at several resolutions (TM-524) each level
 * shows all of them, resampled to its grid; this reads what that level shows.
 */
export async function paintedVoxelMap(
  page: Page,
  originOffset: Vec3,
  resolution?: string,
): Promise<Map<string, string>> {
  const entries = (await page.evaluate(
    ({ offset, level }) => {
      const host = (window as any).viewer.editSessionHost;
      const state = host.painting.state.getState();
      const overlay = host.perLayer.get(state.targetLayerId).overlay;
      const shown = overlay.shownChunksAt(level ?? state.targetResolution);
      const out: Array<[string, string]> = [];
      for (const { origin, chunk } of shown) {
        const [sizeX, sizeY] = chunk.chunkDataSize;
        for (let i = 0; i < chunk.patched.length; i++) {
          if (chunk.patched[i] === 0) continue;
          const x = origin[0] + (i % sizeX) + offset[0];
          const y = origin[1] + (Math.floor(i / sizeX) % sizeY) + offset[1];
          const z = origin[2] + Math.floor(i / (sizeX * sizeY)) + offset[2];
          out.push([`${x},${y},${z}`, chunk.data[i].toString()]);
        }
      }
      return out;
    },
    { offset: [...originOffset], level: resolution },
  )) as Array<[string, string]>;
  return new Map(entries);
}
