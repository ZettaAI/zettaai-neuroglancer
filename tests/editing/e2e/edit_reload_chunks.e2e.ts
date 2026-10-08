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
 * Evicting the datasource must not disturb unsaved paint.
 *
 * `reloadLoadedChunks` exists so a colleague's work in a chunk nobody here
 * painted stops being stale, and it pays for that by evicting the layer's
 * resident chunks. The patch overlay carrying this session's paint draws on
 * top of those chunks and its mask is derived from the very bytes being
 * evicted, so the eviction has to be careful about which patches survive it.
 *
 * This pins it through the real stack: every resident chunk is evicted, the
 * patched ones have their mask re-derived as "what this session changed", and
 * with storage unmoved the refetched bytes are byte-identical — so the paint
 * is still exactly where it was once everything has settled.
 *
 * The half this cannot reach is a colleague actually changing a chunk, which
 * needs a second session and a save; the e2e app registers no save backend, so
 * that rests on `patch_mirror.spec.ts` and on a two-session check by hand.
 */

import { test, expect, type Page } from "@playwright/test";

import type {
  FixturesIndex,
  Scenario,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  openScenarioPage,
  startFixtureGcs,
  warmupPaintPath,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);

const SCENARIO: Scenario = {
  name: "reload-chunks",
  layers: [
    { fixtureId: "img_u8_raw", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};

let fakeGcs: FixtureGcs | undefined;
let fixtures: FixturesIndex | undefined;
let setupError: string | undefined;

test.beforeAll(async () => {
  try {
    fixtures = loadFixturesIndex();
    fakeGcs = await startFixtureGcs();
  } catch (e) {
    setupError = e instanceof Error ? e.message : String(e);
  }
});

test.afterAll(async () => {
  await fakeGcs?.[Symbol.asyncDispose]?.();
});

/** Painted-voxel count of the target layer, once it stops moving. */
async function paintedVoxels(page: Page, timeoutMs = 10000): Promise<number> {
  return (await page.evaluate(async (timeout) => {
    const read = () =>
      (
        window as unknown as {
          __editPaintBenchReadback: () => { paintedVoxels: number };
        }
      ).__editPaintBenchReadback().paintedVoxels;
    const started = performance.now();
    let previous = -1;
    let stable = 0;
    while (performance.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const count = read();
      if (count === previous) {
        if (++stable >= 4) return count;
      } else {
        stable = 0;
      }
      previous = count;
    }
    return previous;
  }, timeoutMs)) as number;
}

/** The slice view, as pixels. */
async function sliceShot(page: Page): Promise<Buffer> {
  const canvas = page.locator("canvas").first();
  return await canvas.screenshot({ animations: "disabled" });
}

test.describe("reloadLoadedChunks", () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    if (setupError !== undefined) return;
    page = await openScenarioPage(browser, {
      scenario: SCENARIO,
      fixtures: fixtures!,
      fakeGcsUrl: fakeGcs!.url,
      appPort: PORT,
    });
    await warmupPaintPath(page, { label: "reload-chunks" });
  });

  test.afterEach(async () => {
    await page?.context().close();
  });

  test("keeps the painted picture across a full refetch", async () => {
    test.skip(setupError !== undefined, setupError);

    await page.evaluate(
      async () =>
        await (
          window as unknown as {
            __editPaintBenchStampReadback: (i: unknown) => Promise<unknown>;
          }
        ).__editPaintBenchStampReadback({ radius: 10, prime: 0 }),
    );
    const paintedBefore = await paintedVoxels(page);
    expect(paintedBefore).toBeGreaterThan(0);
    const before = await sliceShot(page);

    const evicted = (await page.evaluate(() =>
      (globalThis as any).viewer.editSessionHost.reloadLoadedChunks(),
    )) as number;
    expect(evicted).toBeGreaterThan(0);

    // Long enough for every evicted chunk to come back and for the mirror to
    // finish re-deriving the masks over them.
    await page.waitForTimeout(8000);

    expect(await paintedVoxels(page)).toBe(paintedBefore);
    expect((await sliceShot(page)).equals(before)).toBe(true);
  });
});
