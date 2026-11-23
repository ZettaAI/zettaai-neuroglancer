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
 * Two tabs on the same region, against real storage (TM-331 / TM-365).
 *
 * Save-time conflicts: tab B paints one stamp and saves; tab A — opened before
 * B saved — paints a stamp overlapping B's and one in a chunk B never touched,
 * then saves. Each answer to the conflict is checked voxel for voxel against
 * what the dialog promises:
 *
 *   Combine (and automerge, the default) — both sides; theirs wins on overlap.
 *   Take mine — both sides; mine wins on overlap.
 *   Take theirs — theirs; mine survives only in chunks they never touched.
 *   Esc — nothing of mine is saved, and it stays unsaved.
 */

import { test, expect, type Browser, type Page } from "@playwright/test";

import type { Scenario } from "#tests/editing/harness/build_ng_state.js";
import {
  answerDialog,
  clickSaveAll,
  editingFixtures,
  openEditingPage,
  paintedVoxelMap,
  readTargetRegion,
  regionOf,
  saveActive,
  sessionUiState,
  stamp,
  startStorage,
  targetFixture,
  waitForDialogFocus,
  waitForEverythingSaved,
  waitForSaveToSettle,
} from "#tests/editing/harness/save_session.js";
import type { StoredVolume } from "#tests/editing/harness/storage_oracle.js";

const SCENARIO: Scenario = {
  name: "conflict",
  layers: [
    { fixtureId: "img_u8_raw", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};

const MINE = 100;
const THEIRS = 200;

const fixture = () => targetFixture(editingFixtures(), SCENARIO);
const region = () => regionOf(fixture(), SCENARIO);

type VoxelValues = Map<string, string>;

/** Storage as `"x,y,z"` → value. */
function storedValues(volume: StoredVolume): VoxelValues {
  const [startX, startY, startZ] = volume.start;
  const sizeX = volume.end[0] - startX;
  const sizeY = volume.end[1] - startY;
  const values: VoxelValues = new Map();
  volume.values.forEach((value, linearIndex) => {
    const x = startX + (linearIndex % sizeX);
    const y = startY + (Math.floor(linearIndex / sizeX) % sizeY);
    const z = startZ + Math.floor(linearIndex / (sizeX * sizeY));
    values.set(`${x},${y},${z}`, value);
  });
  return values;
}

function chunkOf(key: string): string {
  const { chunk } = fixture();
  return key
    .split(",")
    .map((coordinate, axis) => Math.floor(Number(coordinate) / chunk[axis]))
    .join(",");
}

/** Voxels where `actual` differs from `base` overlaid with `expected`. */
function mismatches(
  base: VoxelValues,
  expected: VoxelValues,
  actual: VoxelValues,
): string[] {
  const wrong: string[] = [];
  for (const [key, value] of actual) {
    const want = expected.get(key) ?? base.get(key);
    if (want !== value) wrong.push(`${key}: want ${want}, got ${value}`);
  }
  return wrong;
}

interface ConflictSetup {
  readonly tabA: Page;
  readonly tabB: Page;
  readonly base: VoxelValues;
  readonly mine: VoxelValues;
  readonly theirs: VoxelValues;
}

/** B saves a stamp; A (opened before that) paints over part of it and elsewhere. */
async function setUpConflict(
  browser: Browser,
  storage: Awaited<ReturnType<typeof startStorage>>,
  automerge: boolean,
): Promise<ConflictSetup> {
  const base = storedValues(
    await readTargetRegion(storage.webApi, fixture(), region()),
  );
  const { page: tabA } = await openEditingPage(browser, SCENARIO, storage);
  const { page: tabB } = await openEditingPage(browser, SCENARIO, storage);

  await stamp(tabB, fixture().offset, {
    value: THEIRS,
    fracX: 0.3,
    fracY: 0.3,
    radius: 5,
  });
  const theirs = await paintedVoxelMap(tabB, fixture().offset);
  expect((await saveActive(tabB)).overall).toBe("all-succeeded");

  const automergeButton = tabA.locator(
    '[aria-label="Combine conflicting edits automatically"]',
  );
  if (
    (await automergeButton.getAttribute("aria-pressed")) !== String(automerge)
  ) {
    await automergeButton.click();
  }
  await expect(automergeButton).toHaveAttribute(
    "aria-pressed",
    String(automerge),
  );

  await stamp(tabA, fixture().offset, {
    value: MINE,
    fracX: 0.32,
    fracY: 0.3,
    radius: 5,
  });
  await stamp(tabA, fixture().offset, {
    value: MINE,
    fracX: 0.7,
    fracY: 0.7,
    radius: 5,
  });
  const mine = await paintedVoxelMap(tabA, fixture().offset);

  // The setup must actually produce what the cases are about.
  const overlap = [...mine.keys()].filter((key) => theirs.has(key));
  const theirChunks = new Set([...theirs.keys()].map(chunkOf));
  const mineElsewhere = [...mine.keys()].filter(
    (key) => !theirChunks.has(chunkOf(key)),
  );
  expect(overlap.length, "no overlapping voxels").toBeGreaterThan(0);
  expect(overlap.length, "mine entirely inside theirs").toBeLessThan(mine.size);
  expect(
    mineElsewhere.length,
    "no stroke outside their chunks",
  ).toBeGreaterThan(0);
  return { tabA, tabB, base, mine, theirs };
}

async function storedNow(
  storage: Awaited<ReturnType<typeof startStorage>>,
): Promise<VoxelValues> {
  return storedValues(
    await readTargetRegion(storage.webApi, fixture(), region()),
  );
}

test.describe("save conflict between two tabs", () => {
  let storage: Awaited<ReturnType<typeof startStorage>>;

  test.beforeEach(async () => {
    storage = await startStorage(test.info().title);
  });

  test.afterEach(async () => {
    await storage?.dispose();
  });

  test("automerge (default) combines without asking — theirs wins where both painted — and says what was replaced", async ({
    browser,
  }) => {
    const { tabA, base, mine, theirs } = await setUpConflict(
      browser,
      storage,
      true,
    );
    await clickSaveAll(tabA);
    await waitForSaveToSettle(tabA);

    const expected = new Map(theirs);
    for (const [key, value] of mine)
      if (!theirs.has(key)) expected.set(key, value);
    expect(mismatches(base, expected, await storedNow(storage))).toEqual([]);

    const ui = await sessionUiState(tabA);
    expect(ui.unsaved).toBe(false);
    expect(ui.dialogs.map((dialog) => dialog.title)).toEqual([
      "Some of your edits were discarded",
    ]);
  });

  test("Combine keeps both sides; theirs wins where both painted", async ({
    browser,
  }) => {
    const { tabA, base, mine, theirs } = await setUpConflict(
      browser,
      storage,
      false,
    );
    await clickSaveAll(tabA);
    await expect
      .poll(async () => (await sessionUiState(tabA)).dialogs)
      .toEqual([
        {
          title: "Someone else edited this region",
          buttons: ["Take theirs", "Take mine", "Combine"],
        },
      ]);
    await answerDialog(tabA, "Combine");
    await waitForEverythingSaved(tabA);

    const expected = new Map(theirs);
    for (const [key, value] of mine)
      if (!theirs.has(key)) expected.set(key, value);
    expect(mismatches(base, expected, await storedNow(storage))).toEqual([]);
    expect((await sessionUiState(tabA)).unsaved).toBe(false);
  });

  test("Take mine keeps both sides; mine wins where both painted", async ({
    browser,
  }) => {
    const { tabA, base, mine, theirs } = await setUpConflict(
      browser,
      storage,
      false,
    );
    await clickSaveAll(tabA);
    await expect
      .poll(async () => (await sessionUiState(tabA)).dialogs.length)
      .toBe(1);
    await answerDialog(tabA, "Take mine");
    await waitForEverythingSaved(tabA);

    const expected = new Map(theirs);
    for (const [key, value] of mine) expected.set(key, value);
    expect(mismatches(base, expected, await storedNow(storage))).toEqual([]);
    expect((await sessionUiState(tabA)).unsaved).toBe(false);
  });

  test("Take theirs drops mine in the conflicting areas and saves the rest", async ({
    browser,
  }) => {
    const { tabA, base, mine, theirs } = await setUpConflict(
      browser,
      storage,
      false,
    );
    await clickSaveAll(tabA);
    await expect
      .poll(async () => (await sessionUiState(tabA)).dialogs.length)
      .toBe(1);
    await answerDialog(tabA, "Take theirs");
    await waitForEverythingSaved(tabA);

    const theirChunks = new Set([...theirs.keys()].map(chunkOf));
    const expected = new Map(theirs);
    for (const [key, value] of mine) {
      if (!theirChunks.has(chunkOf(key))) expected.set(key, value);
    }
    expect(mismatches(base, expected, await storedNow(storage))).toEqual([]);
    expect((await sessionUiState(tabA)).unsaved).toBe(false);
  });

  test("Esc leaves everything as it is: nothing of mine saved, still unsaved", async ({
    browser,
  }) => {
    const { tabA, base, theirs } = await setUpConflict(browser, storage, false);
    await clickSaveAll(tabA);
    await expect
      .poll(async () => (await sessionUiState(tabA)).dialogs.length)
      .toBe(1);
    await waitForDialogFocus(tabA);
    await tabA.keyboard.press("Escape");
    await waitForSaveToSettle(tabA);

    expect(mismatches(base, theirs, await storedNow(storage))).toEqual([]);
    const ui = await sessionUiState(tabA);
    expect(ui.dialogs).toEqual([]);
    expect(ui.unsaved).toBe(true);
  });
});
