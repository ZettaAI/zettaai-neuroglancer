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
 * Edit-session lifecycle e2e (TM-365), against real storage: discard/exit,
 * unconfirmed saves, re-open and continue, and a cancelled save.
 *
 * What a page shows is read through NG's own value lookup and compared with
 * storage read independently from Node (`harness/save_session.ts`), so "the
 * paint was rolled back" means the screen and storage agree, not just that a
 * flag flipped. Undo/redo of a stroke is covered by `edit_undo_redo.e2e.ts`;
 * the exit lock and unload guard by `edit_session_guards.e2e.ts`.
 */

import { test, expect, type Page } from "@playwright/test";

import type { Scenario, Vec3 } from "#tests/editing/harness/build_ng_state.js";
import {
  answerDialog,
  appValuesAt,
  clickExitSession,
  expectStorageHoldsExactly,
  editingFixtures,
  grownInPlane,
  hasUnsavedEdits,
  openEditingPage,
  paintOneStamp,
  PAINT_VALUE,
  readTargetRegion,
  regionOf,
  saveActive,
  sessionUiState,
  stamp,
  startStorage,
  storedValueAt,
  targetFixture,
  voxelsOf,
  waitForSessionActive,
  type ReadbackShape,
} from "#tests/editing/harness/save_session.js";
import {
  changedVoxels,
  voxelSetSignature,
  type StoredVolume,
  type StoredVoxel,
} from "#tests/editing/harness/storage_oracle.js";

const SCENARIO: Scenario = {
  name: "lifecycle",
  layers: [
    { fixtureId: "img_u8_raw", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};

const fixture = () => targetFixture(editingFixtures(), SCENARIO);
const region = () => regionOf(fixture(), SCENARIO);

/** The page shows exactly what storage holds around `box` (± 3 voxels). */
async function expectPageShowsStorage(
  page: Page,
  box: { lo: Vec3; hi: Vec3 },
  stored: StoredVolume,
): Promise<string[]> {
  const probed = voxelsOf(grownInPlane(box, 3, region()));
  const shown = await appValuesAt(page, fixture().id, probed);
  expect(shown).toEqual(probed.map((voxel) => storedValueAt(stored, voxel)));
  return shown;
}

/** Exit through the topbar, answering the unsaved-changes confirmation. */
async function exitDiscarding(page: Page): Promise<void> {
  await clickExitSession(page);
  await expect
    .poll(async () => (await sessionUiState(page)).dialogs.length)
    .toBe(1);
  expect((await sessionUiState(page)).dialogs[0].buttons).toContain(
    "Discard and exit",
  );
  await answerDialog(page, "Discard and exit");
  await waitForSessionActive(page, false);
}

/** The voxels of `changed` inside `box`. */
function within(
  changed: readonly StoredVoxel[],
  box: { lo: Vec3; hi: Vec3 },
): StoredVoxel[] {
  return changed.filter(
    (voxel) =>
      voxel.x >= box.lo[0] &&
      voxel.x < box.hi[0] &&
      voxel.y >= box.lo[1] &&
      voxel.y < box.hi[1] &&
      voxel.z >= box.lo[2] &&
      voxel.z < box.hi[2],
  );
}

let storage: Awaited<ReturnType<typeof startStorage>>;

// Fresh storage per test: each starts from the generated fixtures.
test.beforeEach(async () => {
  storage = await startStorage(test.info().title);
});

test.afterEach(async () => {
  await storage?.dispose();
});

test("Exit → Discard and exit rolls unsaved paint back: storage untouched, the page shows stored data", async ({
  browser,
}) => {
  const { page } = await openEditingPage(browser, SCENARIO, storage);
  const before = await readTargetRegion(storage.webApi, fixture(), region());
  const painted = await paintOneStamp(page, fixture(), region(), before);

  await exitDiscarding(page);

  expect(await hasUnsavedEdits(page)).toBe(false);
  const after = await readTargetRegion(storage.webApi, fixture(), region());
  expect(changedVoxels(before, after)).toEqual([]);
  const shown = await expectPageShowsStorage(page, painted.bbox!, after);
  expect(shown).not.toContain(String(PAINT_VALUE));
  await page.context().close();
});

test("after an unconfirmed save, Exit still asks, and discarding rolls the attempted paint back", async ({
  browser,
}) => {
  // Read-back retries with backoff (~24 s) before it gives up.
  test.setTimeout(3 * 60 * 1000);
  const { page, backend } = await openEditingPage(browser, SCENARIO, storage);
  const before = await readTargetRegion(storage.webApi, fixture(), region());
  const painted = await paintOneStamp(page, fixture(), region(), before);

  backend.failAlways("POST", "/painting/cutout", {
    kind: "acknowledgeWithoutWriting",
  });
  const saved = await saveActive(page);
  expect(saved.progress.kind).toBe("failed");
  expect(saved.unsaved).toBe(true);
  backend.clearFaults();

  // Unconfirmed is not saved: leaving must still ask.
  await exitDiscarding(page);

  expect(await hasUnsavedEdits(page)).toBe(false);
  const after = await readTargetRegion(storage.webApi, fixture(), region());
  expect(changedVoxels(before, after)).toEqual([]);
  const shown = await expectPageShowsStorage(page, painted.bbox!, after);
  expect(shown).not.toContain(String(PAINT_VALUE));
  await page.context().close();
});

test("save → exit → re-open → paint more → save: the re-opened session starts clean on the saved data, and storage ends with both strokes", async ({
  browser,
}) => {
  const { page } = await openEditingPage(browser, SCENARIO, storage);
  const before = await readTargetRegion(storage.webApi, fixture(), region());

  const first = await stamp(page, fixture().offset, { fracX: 0.3, fracY: 0.3 });
  expect(first.paintedVoxels).toBeGreaterThan(0);
  expect((await saveActive(page)).overall).toBe("all-succeeded");
  const savedOnce = await readTargetRegion(storage.webApi, fixture(), region());
  expectStorageHoldsExactly(changedVoxels(before, savedOnce), first);

  // Nothing unsaved: Exit leaves without asking.
  const config = await page.evaluate(
    () => (window as any).viewer.editSessionHost.activeSessionConfig,
  );
  await clickExitSession(page);
  await waitForSessionActive(page, false);
  expect((await sessionUiState(page)).dialogs).toEqual([]);

  await page.evaluate(async (sessionConfig) => {
    await (window as any).viewer.editSessionHost.openSession(sessionConfig);
  }, config);
  await waitForSessionActive(page, true);
  expect(await hasUnsavedEdits(page)).toBe(false);
  await expectPageShowsStorage(page, first.bbox!, savedOnce);

  const second: ReadbackShape = await stamp(page, fixture().offset, {
    fracX: 0.7,
    fracY: 0.7,
  });
  expect(second.paintedVoxels).toBeGreaterThan(0);
  // The re-opened session's own paint is only the second stroke.
  expect(second.signature).not.toBe(first.signature);
  expect((await saveActive(page)).overall).toBe("all-succeeded");

  const savedTwice = await readTargetRegion(
    storage.webApi,
    fixture(),
    region(),
  );
  const changed = changedVoxels(before, savedTwice);
  expect(changed.length).toBe(first.paintedVoxels + second.paintedVoxels);
  expect(voxelSetSignature(within(changed, first.bbox!))).toBe(first.signature);
  expect(voxelSetSignature(within(changed, second.bbox!))).toBe(
    second.signature,
  );
  await page.context().close();
});

test("cancelling a save mid-flight reports nothing saved and keeps the paint; the next save persists it", async ({
  browser,
}) => {
  const { page, backend } = await openEditingPage(browser, SCENARIO, storage);
  const before = await readTargetRegion(storage.webApi, fixture(), region());
  const painted = await paintOneStamp(page, fixture(), region(), before);

  backend.failAlways("POST", "/painting/cutout", { kind: "hang" });
  await page.evaluate(() => {
    const host = (window as any).viewer.editSessionHost;
    (window as any).__e2eSave = host.saveActive().then(
      (result: any) => ({
        overall: result.overall,
        outcomes: result.outcomes.map((outcome: any) => ({
          status: outcome.status,
          errorCode: outcome.error?.code,
          message: outcome.error?.message,
        })),
      }),
      (error: unknown) => ({ threw: String(error) }),
    );
  });
  await expect.poll(() => backend.hanging).toBeGreaterThan(0);

  await page.evaluate(() =>
    (window as any).viewer.editSessionHost.cancelActiveSave(),
  );
  const cancelled = await page.evaluate(() => (window as any).__e2eSave);
  backend.clearFaults();

  expect(cancelled.overall).toBe("all-failed");
  expect(cancelled.outcomes).toHaveLength(1);
  expect(cancelled.outcomes[0].errorCode).toBe("save-partial");
  expect(cancelled.outcomes[0].message).toMatch(/cancelled-after-0-of-/);
  expect(await hasUnsavedEdits(page)).toBe(true);
  expect(
    changedVoxels(
      before,
      await readTargetRegion(storage.webApi, fixture(), region()),
    ),
  ).toEqual([]);

  const retried = await saveActive(page);
  expect(retried.overall, JSON.stringify(retried.outcomes)).toBe(
    "all-succeeded",
  );
  expect(retried.unsaved).toBe(false);
  expectStorageHoldsExactly(
    changedVoxels(
      before,
      await readTargetRegion(storage.webApi, fixture(), region()),
    ),
    painted,
  );
  await page.context().close();
});
