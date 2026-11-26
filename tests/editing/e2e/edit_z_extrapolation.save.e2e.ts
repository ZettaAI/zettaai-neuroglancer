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
 * Z-extrapolation end to end (TM-331): the panel's Run, Reset and segment
 * tracking, the real `POST /segmentation/propagate_mask` route, and the save.
 *
 * The web API route is the production handler; only the model behind it is a
 * stand-in (`harness/webapi_app.py`) that moves the mask `SHIFT_X` voxels
 * along +x. So a run must paint the tracked voxels of the current slice,
 * shifted, on the next slice — known exactly, without a GPU. What the model
 * itself predicts is out of scope here.
 *
 * The client side is checked from both ends: what the stand-in received (the
 * labelled mask and both image slices, by hash of the fixture's known
 * contents) and what the session and then storage hold afterwards.
 */

import { createHash } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import type { Scenario } from "#tests/editing/harness/build_ng_state.js";
import {
  editingFixtures,
  openEditingPage,
  paintedVoxelMap,
  readTargetRegion,
  regionOf,
  saveActive,
  stampAtVoxel,
  startStorage,
  targetFixture,
  type WebApi,
} from "#tests/editing/harness/save_session.js";
import { changedVoxels } from "#tests/editing/harness/storage_oracle.js";

/** `PROPAGATION_SHIFT_X` in `harness/webapi_app.py`. */
const SHIFT_X = 3;
const TARGET = "seg_u64_cseg";
const IMAGE = "img_u8_raw";
/** Segment IDs the fixtures never use (they hold 1..7). */
const TRACKED = 100;
const UNTRACKED = 101;
const DAB_CENTRE: [number, number] = [40, 64];
const DAB_RADIUS = 6;

function scenarioListing(segments: readonly number[]): Scenario {
  return {
    name: `z-extrapolation, listed ${segments.join(", ")}`,
    layers: [
      { fixtureId: IMAGE, role: "image", writable: false },
      {
        fixtureId: TARGET,
        role: "target",
        writable: true,
        segments: segments.map(String),
      },
    ],
  };
}

interface PropagationRequest {
  shape: [number, number];
  mask_dtype: string;
  mask_labels: number[];
  mask_voxels: number;
  current_image_sha256: string;
  next_image_sha256: string;
}

async function propagationRequests(
  webApi: WebApi,
): Promise<PropagationRequest[]> {
  const response = await fetch(`${webApi.url}/e2e/propagation-requests`);
  expect(response.status).toBe(200);
  return (await response.json()) as PropagationRequest[];
}

/**
 * The SHA-256 of one section of `img_u8_raw` over [0, size) in x and y, laid
 * out x-fastest: the generator's gradient `(2x + y) mod 256`, the same on
 * every section.
 */
function gradientSectionSha256(width: number, height: number): string {
  const bytes = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) bytes[y * width + x] = (2 * x + y) % 256;
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/** `"x,y,z"` keys moved by `dx` along x and onto section `z`. */
function movedTo(keys: Iterable<string>, dx: number, z: number): string[] {
  return [...keys].map((key) => {
    const [x, y] = key.split(",").map(Number);
    return `${x + dx},${y},${z}`;
  });
}

const sortedKeys = (keys: Iterable<string>) => [...keys].sort();

const viewSlice = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Math.floor(
      (window as any).viewer.navigationState.position.value[2] as number,
    ),
  );

/** Move the view `delta` sections along z. */
const stepSection = (page: Page, delta: number): Promise<void> =>
  page.evaluate((step) => {
    const viewer = (window as any).viewer;
    const position = Float32Array.from(viewer.position.value as Float32Array);
    position[2] += step;
    viewer.position.value = position;
  }, delta);

const toolState = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as any
    ).viewer.editSessionHost.zExtrapolationTool.getState();
    return {
      isRunning: state.isRunning as boolean,
      currentZ: state.currentZ as number | undefined,
      hasLastRun: state.hasLastRun as boolean,
    };
  });

/** Pick the tool in the topbar, as a user does, and wait for its panel. */
async function openZExtrapolation(page: Page): Promise<void> {
  await page.locator('button[aria-label^="Z-extrapolation"]').click();
  await expect(page.locator(".neuroglancer-z-extrapolation-run")).toBeVisible();
}

/** Click Run and wait until the step has landed on `currentZ + 1`. */
async function runNextSlice(page: Page, nextZ: number): Promise<void> {
  const run = page.locator(".neuroglancer-z-extrapolation-run");
  await expect(run).toBeEnabled();
  await run.click();
  await expect
    .poll(() => toolState(page), { timeout: 30_000 })
    .toEqual({ isRunning: false, currentZ: nextZ, hasLastRun: true });
}

test.describe("z-extrapolation", () => {
  let storage: Awaited<ReturnType<typeof startStorage>>;

  test.beforeEach(async () => {
    storage = await startStorage(test.info().title);
  });

  test.afterEach(async () => {
    await storage?.dispose();
  });

  const fixture = () =>
    targetFixture(editingFixtures(), scenarioListing([TRACKED]));
  const region = () => regionOf(fixture(), scenarioListing([TRACKED]));

  async function paintDab(page: Page): Promise<string[]> {
    await stampAtVoxel(page, DAB_CENTRE, {
      layerId: TARGET,
      originOffset: region().lo,
      radius: DAB_RADIUS,
      value: TRACKED,
    });
    const dab = [...(await paintedVoxelMap(page, region().lo)).keys()];
    expect(dab.length, "the dab painted").toBeGreaterThan(0);
    return dab;
  }

  test("three runs carry the drawn shape forward one section each, and the save stores every section", async ({
    browser,
  }) => {
    const scenario = scenarioListing([TRACKED]);
    const before = await readTargetRegion(storage.webApi, fixture(), region());
    const { page, backend } = await openEditingPage(browser, scenario, storage);
    const startZ = await viewSlice(page);
    const dab = await paintDab(page);

    await openZExtrapolation(page);
    await expect(page.locator(".neuroglancer-z-extrapolation-run")).toHaveText(
      "Run next slice (1 segment)",
    );
    for (const step of [1, 2, 3]) await runNextSlice(page, startZ + step);

    const expected = [
      ...dab,
      ...[1, 2, 3].flatMap((step) =>
        movedTo(dab, step * SHIFT_X, startZ + step),
      ),
    ];
    const shown = await paintedVoxelMap(page, region().lo);
    expect(sortedKeys(shown.keys())).toEqual(sortedKeys(expected));
    expect(new Set(shown.values())).toEqual(new Set([String(TRACKED)]));
    // The view follows the runs to the last section written.
    expect(await viewSlice(page)).toBe(startZ + 3);

    // What the client sent: the whole region, the tracked segment as label 1
    // on each current section, and the image's current and next sections.
    const [width, height] = [
      region().hi[0] - region().lo[0],
      region().hi[1] - region().lo[1],
    ];
    const imageSha = gradientSectionSha256(width, height);
    expect(await propagationRequests(storage.webApi)).toEqual(
      [0, 1, 2].map(() => ({
        shape: [height, width],
        mask_dtype: "uint8",
        mask_labels: [0, 1],
        mask_voxels: dab.length,
        current_image_sha256: imageSha,
        next_image_sha256: imageSha,
      })),
    );
    expect(
      backend.requests
        .filter((request) => request.pathname.startsWith("/segmentation/"))
        .map((request) => [request.method, request.pathname, request.status]),
    ).toEqual(Array(3).fill(["POST", "/segmentation/propagate_mask", 200]));

    const saved = await saveActive(page);
    expect(saved.overall, JSON.stringify(saved.outcomes)).toBe("all-succeeded");
    expect(saved.progress.kind, "read-back verification").toBe("idle");
    expect(saved.unsaved).toBe(false);
    const changed = changedVoxels(
      before,
      await readTargetRegion(storage.webApi, fixture(), region()),
    );
    expect(
      sortedKeys(changed.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`)),
    ).toEqual(sortedKeys(expected));
    expect(new Set(changed.map((voxel) => voxel.value))).toEqual(
      new Set([String(TRACKED)]),
    );
    await page.context().close();
  });

  test("Reset undoes only the last run and returns to its section", async ({
    browser,
  }) => {
    const { page } = await openEditingPage(
      browser,
      scenarioListing([TRACKED]),
      storage,
    );
    const startZ = await viewSlice(page);
    const dab = await paintDab(page);
    await openZExtrapolation(page);
    await runNextSlice(page, startZ + 1);
    await runNextSlice(page, startZ + 2);

    const reset = page.locator(".neuroglancer-z-extrapolation-reset");
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect
      .poll(() => toolState(page))
      .toEqual({ isRunning: false, currentZ: startZ + 1, hasLastRun: false });
    expect(await viewSlice(page)).toBe(startZ + 1);
    expect(
      sortedKeys((await paintedVoxelMap(page, region().lo)).keys()),
    ).toEqual(sortedKeys([...dab, ...movedTo(dab, SHIFT_X, startZ + 1)]));
    await expect(reset).toBeDisabled();
    await page.context().close();
  });

  test("an untracked listed segment on the next section keeps its voxels", async ({
    browser,
  }) => {
    const { page } = await openEditingPage(
      browser,
      scenarioListing([TRACKED, UNTRACKED]),
      storage,
    );
    const startZ = await viewSlice(page);
    const dab = await paintDab(page);
    // On the next section, a segment where the run will write.
    await stepSection(page, 1);
    await stampAtVoxel(page, [DAB_CENTRE[0] + SHIFT_X, DAB_CENTRE[1]], {
      layerId: TARGET,
      originOffset: region().lo,
      radius: 3,
      value: UNTRACKED,
    });
    const painted = await paintedVoxelMap(page, region().lo);
    const kept = [...painted]
      .filter(([, value]) => value === String(UNTRACKED))
      .map(([key]) => key);
    expect(kept.length, "the untracked segment painted").toBeGreaterThan(0);
    await stepSection(page, -1);

    await openZExtrapolation(page);
    const untrack = page.getByRole("button", {
      name: `Track segment ${UNTRACKED}`,
    });
    await expect(untrack).toHaveAttribute("aria-pressed", "true");
    await untrack.click();
    await expect(untrack).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".neuroglancer-z-extrapolation-run")).toHaveText(
      "Run next slice (1 segment)",
    );
    await runNextSlice(page, startZ + 1);

    const shown = await paintedVoxelMap(page, region().lo);
    const keptSet = new Set(kept);
    const expected = new Map<string, string>([
      ...dab.map((key) => [key, String(TRACKED)] as const),
      ...kept.map((key) => [key, String(UNTRACKED)] as const),
      ...movedTo(dab, SHIFT_X, startZ + 1)
        .filter((key) => !keptSet.has(key))
        .map((key) => [key, String(TRACKED)] as const),
    ]);
    expect(
      movedTo(dab, SHIFT_X, startZ + 1).filter((key) => keptSet.has(key))
        .length,
      "the run's shape overlaps the untracked segment",
    ).toBeGreaterThan(0);
    expect([...shown].sort()).toEqual([...expected].sort());
    await page.context().close();
  });
});
