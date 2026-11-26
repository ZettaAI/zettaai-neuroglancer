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
 * The edit region's boundary, end to end (TM-366): a stroke that crosses it
 * paints and saves only its part inside, and storage outside the region does
 * not change.
 *
 * The expected inside part is the same dab painted in a session whose region
 * is the whole layer, cut at the boundary — so the test does not rely on how
 * the brush rasterizes a disk. Storage is read over the whole layer, not only
 * the region, so a write past the boundary would show.
 */

import { test, expect } from "@playwright/test";

import type { Scenario } from "#tests/editing/harness/build_ng_state.js";
import {
  boxWithin,
  cutoutWrites,
  editingFixtures,
  hasUnsavedEdits,
  openEditingPage,
  paintedVoxelMap,
  PAINT_VALUE,
  postedBox,
  readTargetRegion,
  regionOf,
  saveActive,
  stampAtVoxel,
  startStorage,
  targetFixture,
} from "#tests/editing/harness/save_session.js";
import { changedVoxels } from "#tests/editing/harness/storage_oracle.js";

const TARGET = "seg_u64_cseg";
const WHOLE_LAYER: Scenario = {
  name: "region: the whole layer",
  layers: [{ fixtureId: TARGET, role: "target", writable: true }],
};
/** Ends at x = y = 96, inside the layer's second chunk column and row. */
const PART_OF_LAYER: Scenario = {
  name: "region: 96×96 of a 128×128 layer",
  layers: [{ fixtureId: TARGET, role: "target", writable: true }],
  regionSize: [96, 96, 16],
};
const RADIUS = 6;

const sortedKeys = (keys: Iterable<string>) => [...keys].sort();

test.describe("save: the edit region's boundary", () => {
  let storage: Awaited<ReturnType<typeof startStorage>>;

  test.beforeEach(async () => {
    storage = await startStorage(test.info().title);
  });

  test.afterEach(async () => {
    await storage?.dispose();
  });

  const fixture = () => targetFixture(editingFixtures(), WHOLE_LAYER);
  const layer = () => regionOf(fixture(), WHOLE_LAYER);
  const region = () => regionOf(fixture(), PART_OF_LAYER);

  test("a dab across the boundary paints and saves only its part inside the region", async ({
    browser,
  }) => {
    const centre: [number, number] = [region().hi[0] - 1, 40];

    const reference = await openEditingPage(browser, WHOLE_LAYER, storage);
    await stampAtVoxel(reference.page, centre, {
      layerId: TARGET,
      originOffset: layer().lo,
      radius: RADIUS,
    });
    const wholeDab = await paintedVoxelMap(reference.page, layer().lo);
    await reference.page.context().close();
    const isInside = (key: string) => {
      const [x, y, z] = key.split(",").map(Number);
      return [x, y, z].every(
        (coordinate, axis) =>
          coordinate >= region().lo[axis] && coordinate < region().hi[axis],
      );
    };
    const expected = [...wholeDab.keys()].filter(isInside);
    expect(
      [...wholeDab.keys()].filter((key) => !isInside(key)).length,
      "the dab reaches past the boundary",
    ).toBeGreaterThan(0);
    expect(expected.length, "the dab reaches inside").toBeGreaterThan(0);

    const before = await readTargetRegion(storage.webApi, fixture(), layer());
    const { page, backend } = await openEditingPage(
      browser,
      PART_OF_LAYER,
      storage,
    );
    const painted = await stampAtVoxel(page, centre, {
      layerId: TARGET,
      originOffset: layer().lo,
      radius: RADIUS,
    });
    expect(painted.distinctValues).toEqual([String(PAINT_VALUE)]);
    expect(
      sortedKeys((await paintedVoxelMap(page, layer().lo)).keys()),
    ).toEqual(sortedKeys(expected));

    const saved = await saveActive(page);
    expect(saved.overall, JSON.stringify(saved.outcomes)).toBe("all-succeeded");
    expect(saved.progress.kind, "read-back verification").toBe("idle");
    expect(saved.unsaved).toBe(false);
    const writes = cutoutWrites(backend);
    expect(writes.map((write) => write.status)).toEqual(
      Array(painted.chunkCount).fill(200),
    );
    for (const write of writes) {
      expect(boxWithin(postedBox(write.query), region())).toBe(true);
    }

    const changed = changedVoxels(
      before,
      await readTargetRegion(storage.webApi, fixture(), layer()),
    );
    expect(
      sortedKeys(changed.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`)),
    ).toEqual(sortedKeys(expected));
    expect(new Set(changed.map((voxel) => voxel.value))).toEqual(
      new Set([String(PAINT_VALUE)]),
    );
    await page.context().close();
  });

  test("a dab wholly outside the region paints nothing and leaves nothing to save", async ({
    browser,
  }) => {
    const centre: [number, number] = [region().hi[0] + RADIUS + 2, 40];
    // The same dab in a whole-layer session paints, so it does reach the app.
    const reference = await openEditingPage(browser, WHOLE_LAYER, storage);
    const referenceDab = await stampAtVoxel(reference.page, centre, {
      layerId: TARGET,
      originOffset: layer().lo,
      radius: RADIUS,
    });
    expect(referenceDab.paintedVoxels).toBeGreaterThan(0);
    await reference.page.context().close();

    const { page, backend } = await openEditingPage(
      browser,
      PART_OF_LAYER,
      storage,
    );
    const painted = await stampAtVoxel(page, centre, {
      layerId: TARGET,
      originOffset: layer().lo,
      radius: RADIUS,
    });
    expect(painted.paintedVoxels).toBe(0);
    expect(await hasUnsavedEdits(page)).toBe(false);
    expect(cutoutWrites(backend)).toEqual([]);
    await page.context().close();
  });
});
