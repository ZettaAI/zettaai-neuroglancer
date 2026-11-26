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
 * The brush's "Fill inside" (TM-268) end to end: a ring drawn with the real
 * mouse, the switch flipped in the brush panel, the result saved.
 *
 * "Inside" is what cannot be reached from outside without crossing the
 * stroke, stepping along x and y (`stroke_enclosure.ts`). The test takes the
 * outline from the same ring drawn with the switch off and computes what it
 * encloses itself, so the expected fill does not come from the code under
 * test. The ring is drawn slowly enough for the brush to keep every sample
 * (see the swept-stroke test in `edit_paint_mask.e2e.ts`), so both drawings
 * stamp the same outline.
 */

import { test, expect, type Page } from "@playwright/test";

import type { Scenario } from "#tests/editing/harness/build_ng_state.js";
import {
  editingFixtures,
  hasUnsavedEdits,
  openEditingPage,
  paintedVoxelMap,
  readTargetRegion,
  regionOf,
  saveActive,
  startStorage,
  targetFixture,
} from "#tests/editing/harness/save_session.js";
import { changedVoxels } from "#tests/editing/harness/storage_oracle.js";

const TARGET = "seg_u64_cseg";
const SCENARIO: Scenario = {
  name: "fill inside",
  layers: [{ fixtureId: TARGET, role: "target", writable: true }],
};
/** A segment ID the fixture never uses (it holds 1..7). */
const PAINT_VALUE = 100;
const RING_CENTRE: [number, number] = [48, 48];
const RING_RADIUS = 10;
const RING_POINTS = 32;
const BRUSH_RADIUS = 2;
const STEP_MS = 150;

/** The ring through voxel centres, ending where it started. */
function ringPath(): Array<[number, number]> {
  return Array.from({ length: RING_POINTS + 1 }, (_, i) => {
    const angle = (2 * Math.PI * i) / RING_POINTS;
    return [
      RING_CENTRE[0] + RING_RADIUS * Math.cos(angle),
      RING_CENTRE[1] + RING_RADIUS * Math.sin(angle),
    ];
  });
}

/** Viewport point of an absolute voxel position on the slice in view. */
async function clientPointsOf(
  page: Page,
  voxels: ReadonlyArray<readonly [number, number]>,
): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(
    (points) => {
      const viewer = (window as any).viewer;
      const [centreX, centreY] = Array.from(
        viewer.navigationState.position.value as Float32Array,
      );
      const voxelsPerPixel = viewer.crossSectionScale.value as number;
      const rect = document
        .querySelector(".neuroglancer-rendered-data-panel")!
        .getBoundingClientRect();
      return points.map(([x, y]) => ({
        x: rect.left + rect.width / 2 + (x + 0.5 - centreX) / voxelsPerPixel,
        y: rect.top + rect.height / 2 + (y + 0.5 - centreY) / voxelsPerPixel,
      }));
    },
    voxels.map(([x, y]) => [x, y]),
  );
}

const strokeIsLive = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).viewer.editSessionHost.hasLiveEdit);

/** Every painted voxel, once two reads a moment apart agree. */
async function settledPaint(page: Page): Promise<Map<string, string>> {
  await expect.poll(() => strokeIsLive(page), { timeout: 30_000 }).toBe(false);
  let previous = await paintedVoxelMap(page, [0, 0, 0]);
  for (;;) {
    await page.waitForTimeout(300);
    const current = await paintedVoxelMap(page, [0, 0, 0]);
    if (JSON.stringify([...current]) === JSON.stringify([...previous])) {
      return current;
    }
    previous = current;
  }
}

/** Draw the ring with the real mouse, slowly enough to keep every sample. */
async function drawRing(page: Page): Promise<Map<string, string>> {
  const points = await clientPointsOf(page, ringPath());
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.waitForTimeout(STEP_MS);
    await page.mouse.move(point.x, point.y);
  }
  await page.mouse.up();
  return settledPaint(page);
}

/**
 * The voxels `outline` encloses on its slice: those not reachable from outside
 * its bounding box by steps along x and y without crossing it.
 */
function enclosedBy(outline: Iterable<string>): string[] {
  const cells = [...outline].map((key) => key.split(",").map(Number));
  const z = cells[0][2];
  const isOutline = new Set(cells.map(([x, y]) => `${x},${y}`));
  const loX = Math.min(...cells.map(([x]) => x)) - 1;
  const hiX = Math.max(...cells.map(([x]) => x)) + 1;
  const loY = Math.min(...cells.map(([, y]) => y)) - 1;
  const hiY = Math.max(...cells.map(([, y]) => y)) + 1;
  const outside = new Set<string>([`${loX},${loY}`]);
  const queue: Array<[number, number]> = [[loX, loY]];
  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    for (const [nextX, nextY] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]) {
      const key = `${nextX},${nextY}`;
      if (nextX < loX || nextX > hiX || nextY < loY || nextY > hiY) continue;
      if (isOutline.has(key) || outside.has(key)) continue;
      outside.add(key);
      queue.push([nextX, nextY]);
    }
  }
  const enclosed: string[] = [];
  for (let x = loX; x <= hiX; x++) {
    for (let y = loY; y <= hiY; y++) {
      const key = `${x},${y}`;
      if (!isOutline.has(key) && !outside.has(key)) {
        enclosed.push(`${key},${z}`);
      }
    }
  }
  return enclosed;
}

const sortedKeys = (keys: Iterable<string>) => [...keys].sort();

/** Pick the brush fresh (so its panel opens) and set it up for the ring. */
async function prepareBrush(page: Page): Promise<void> {
  // The warm-up left the brush active, and clicking the active tool only
  // toggles its panel: pick another tool first, as a user would.
  await page.locator('button[aria-label^="Cursor"]').click();
  await page.locator('button[aria-label^="Brush"]').click();
  await page.evaluate(
    ({ radius, value }) =>
      (window as any).viewer.editSessionHost.painting.state.patchState({
        radius,
        activeValue: value,
        mask: undefined,
      }),
    { radius: BRUSH_RADIUS, value: PAINT_VALUE },
  );
}

/**
 * The ring drawn with "Fill inside" off (then undone) and on: the outline the
 * brush paints, what that outline encloses, and what the filled stroke paints.
 */
async function outlineAndFilledRing(page: Page): Promise<{
  outline: Map<string, string>;
  enclosed: string[];
  filled: Map<string, string>;
}> {
  await prepareBrush(page);
  const fillInside = page.getByRole("switch", { name: "Fill inside" });
  await expect(fillInside).toHaveAttribute("aria-checked", "false");

  const outline = await drawRing(page);
  expect(outline.size, "the ring was drawn").toBeGreaterThan(0);
  const enclosed = enclosedBy(outline.keys());
  expect(enclosed.length, "the ring is closed").toBeGreaterThan(0);
  await page.evaluate(async () => {
    const session = (window as any).viewer.editSessionHost.activeSession.value;
    while (session.getHistory().canUndo) await session.undo();
  });
  expect((await settledPaint(page)).size).toBe(0);
  expect(await hasUnsavedEdits(page)).toBe(false);

  await fillInside.click();
  await expect(fillInside).toHaveAttribute("aria-checked", "true");
  const filled = await drawRing(page);
  expect(new Set(filled.values())).toEqual(new Set([String(PAINT_VALUE)]));
  return { outline, enclosed, filled };
}

test.describe("brush: Fill inside", () => {
  let storage: Awaited<ReturnType<typeof startStorage>>;

  test.beforeEach(async () => {
    storage = await startStorage(test.info().title);
  });

  test.afterEach(async () => {
    await storage?.dispose();
  });

  test("a closed ring with the switch on paints its outline and everything it encloses, as one undoable stroke; the save stores what the session shows", async ({
    browser,
  }) => {
    const fixture = targetFixture(editingFixtures(), SCENARIO);
    const region = regionOf(fixture, SCENARIO);
    const before = await readTargetRegion(storage.webApi, fixture, region);
    const { page } = await openEditingPage(browser, SCENARIO, storage);
    const { outline, enclosed, filled } = await outlineAndFilledRing(page);

    const missing = [...outline.keys(), ...enclosed].filter(
      (key) => !filled.has(key),
    );
    expect(missing, "outline or enclosed voxels not painted").toEqual([]);

    // The ring and its fill are one stroke: one undo removes both, one redo
    // brings both back.
    const canUndoAfterOneUndo = await page.evaluate(async () => {
      const session = (window as any).viewer.editSessionHost.activeSession
        .value;
      await session.undo();
      return session.getHistory().canUndo as boolean;
    });
    expect(canUndoAfterOneUndo, "more than one undo entry").toBe(false);
    expect((await settledPaint(page)).size).toBe(0);
    await page.evaluate(() =>
      (window as any).viewer.editSessionHost.activeSession.value.redo(),
    );
    expect(sortedKeys((await settledPaint(page)).keys())).toEqual(
      sortedKeys(filled.keys()),
    );

    const saved = await saveActive(page);
    expect(saved.overall, JSON.stringify(saved.outcomes)).toBe("all-succeeded");
    expect(saved.progress.kind, "read-back verification").toBe("idle");
    expect(saved.unsaved).toBe(false);
    const changed = changedVoxels(
      before,
      await readTargetRegion(storage.webApi, fixture, region),
    );
    expect(
      sortedKeys(changed.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`)),
    ).toEqual(sortedKeys(filled.keys()));
    expect(new Set(changed.map((voxel) => voxel.value))).toEqual(
      new Set([String(PAINT_VALUE)]),
    );
    await page.context().close();
  });

  test("the fill adds only what the outline encloses, nothing outside the drawn stroke", async ({
    browser,
  }) => {
    test.fail(
      true,
      "The brush paints a Catmull-Rom-smoothed, resampled path (TM-318), but " +
        "the enclosure is traced with straight segments between the raw " +
        "samples (stroke_enclosure.ts), and its contour is painted too: at " +
        "the ring's sharpest turns it lands one voxel outside the drawn stroke.",
    );
    const { page } = await openEditingPage(browser, SCENARIO, storage);
    const { outline, enclosed, filled } = await outlineAndFilledRing(page);
    const allowed = new Set([...outline.keys(), ...enclosed]);
    expect(
      [...filled.keys()].filter((key) => !allowed.has(key)),
      "painted outside the outline and what it encloses",
    ).toEqual([]);
    await page.context().close();
  });
});
