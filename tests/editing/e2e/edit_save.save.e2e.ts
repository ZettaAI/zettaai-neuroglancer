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
 * Edit-session SAVE e2e (TM-331, TM-361): paint → save → what storage holds →
 * what a reloaded page shows; and how failed or unconfirmed saves surface.
 *
 * The whole production save path runs: NG's `HttpSaveBackend` (payload, gzip,
 * retry, 409 replay), the stale-baseline scan and read-back verification
 * (TM-352), and the web API's real `POST /painting/cutout` handler writing
 * through CloudVolume / `chunk_cas` into the fixtures' fake-gcs. Only the
 * storage service (fake-gcs) and the auth header (none) stand in for prod.
 *
 * The expected result is never taken from the app alone: storage is read from
 * Node through the web API before and after the save (`storage_oracle.ts`), and
 * the set of voxels the save changed must equal — voxel for voxel, by count and
 * by signature — the set the app showed as painted.
 *
 * Needs `ZETTA_UTILS_DIR` (see `harness/webapi_server.mjs`). Runs as its own
 * Playwright project: `npm run e2e:save`.
 */

import { test, expect, type Browser, type Page } from "@playwright/test";

import type { Scenario, Vec3 } from "#tests/editing/harness/build_ng_state.js";
import { openScenarioPage } from "#tests/editing/harness/e2e_setup.js";
import {
  appValuesAt,
  boxWithin,
  cutoutWrites,
  editingFixtures,
  expectStorageHoldsExactly,
  grownInPlane,
  hasUnsavedEdits,
  openEditingPage,
  paintedVoxelMap,
  paintOneStamp,
  PAINT_VALUE,
  PORT,
  postedBox,
  readTargetRegion,
  regionOf,
  saveActive,
  stamp,
  startStorage,
  storagePath,
  storedValueAt,
  targetFixture,
  voxelsOf,
} from "#tests/editing/harness/save_session.js";
import {
  changedVoxels,
  readStoredVolume,
  type StoredDataType,
} from "#tests/editing/harness/storage_oracle.js";

const SCENARIOS: readonly Scenario[] = [
  {
    name: "img-locked + cseg-target",
    layers: [
      { fixtureId: "img_u8_raw", role: "image", writable: false },
      { fixtureId: "seg_u64_cseg", role: "target", writable: true },
    ],
  },
  {
    name: "offset-seg-target",
    layers: [
      { fixtureId: "seg_u32_raw_offset", role: "target", writable: true },
    ],
  },
  {
    name: "multires-seg-target",
    layers: [{ fixtureId: "seg_u64_multires", role: "target", writable: true }],
  },
  {
    // TM-366: a region inside one chunk; the save still writes whole chunks
    // only within it.
    name: "sub-chunk-region",
    layers: [{ fixtureId: "seg_u64_cseg", role: "target", writable: true }],
    regionSize: [32, 32, 16],
  },
  {
    // TM-366: a region that ends mid-chunk in y; the centre stamp at x = 64
    // spans two chunk columns.
    name: "unaligned-region",
    layers: [{ fixtureId: "seg_u64_cseg", role: "target", writable: true }],
    regionSize: [128, 80, 16],
  },
  {
    // One 8192-voxel-wide chunk (TM-363): the datasource reads it and the save
    // writes it back through the real chunk path.
    name: "wide-chunk-seg-target",
    layers: [{ fixtureId: "seg_u8_bigchunk", role: "target", writable: true }],
  },
];

/** The scenario the failure tests paint in. */
const FAILURE_SCENARIO = SCENARIOS[0];

for (const scenario of SCENARIOS) {
  test.describe(`save: ${scenario.name}`, () => {
    let storage: Awaited<ReturnType<typeof startStorage>>;

    test.beforeAll(async () => {
      storage = await startStorage(scenario.name);
    });

    test.afterAll(async () => {
      await storage?.dispose();
    });

    test("paint → save → reload: storage holds exactly the painted voxels, and the reloaded page shows them", async ({
      browser,
    }) => {
      const fixture = targetFixture(editingFixtures(), scenario);
      const region = regionOf(fixture, scenario);
      const { page, backend } = await openEditingPage(
        browser,
        scenario,
        storage,
      );

      const before = await readTargetRegion(storage.webApi, fixture, region);
      const painted = await paintOneStamp(page, fixture, region, before);

      const saved = await saveActive(page);
      expect(saved.overall, JSON.stringify(saved.outcomes)).toBe(
        "all-succeeded",
      );
      expect(saved.progress.kind, "read-back verification").toBe("idle");
      expect(saved.unsaved).toBe(false);

      // One write per dirty chunk, at the painted resolution, inside the
      // task region, all accepted.
      const writes = cutoutWrites(backend);
      expect(
        writes.map((write) => write.status),
        storage.webApi.output().slice(-4000),
      ).toEqual(Array(painted.chunkCount).fill(200));
      for (const write of writes) {
        expect(write.query.get("path")).toBe(
          storagePath(editingFixtures(), fixture),
        );
        expect(write.query.getAll("resolution").map(Number)).toEqual([
          ...fixture.resolutions[0],
        ]);
        expect(boxWithin(postedBox(write.query), region)).toBe(true);
      }

      const after = await readTargetRegion(storage.webApi, fixture, region);
      expectStorageHoldsExactly(changedVoxels(before, after), painted);
      await page.context().close();

      // A new page reads everything from storage again.
      const reloaded = await openScenarioPage(browser, {
        scenario,
        fixtures: editingFixtures(),
        fakeGcsUrl: storage.fakeGcs.url,
        appPort: PORT,
      });
      expect(await hasUnsavedEdits(reloaded)).toBe(false);
      const probed = voxelsOf(grownInPlane(painted.bbox!, 3, region));
      const shown = await appValuesAt(reloaded, fixture.id, probed);
      const stored = probed.map((voxel) => storedValueAt(after, voxel));
      expect(shown).toEqual(stored);
      expect(
        shown.filter((value) => value === String(PAINT_VALUE)),
      ).toHaveLength(painted.paintedVoxels);
      await reloaded.context().close();
    });
  });
}

/**
 * One layer, two resolutions, one session (TM-363): a stroke at 16 nm and a
 * stroke at 32 nm, switched with the target-resolution picker in between.
 *
 * The 32 nm stroke's expected voxels come from a session that paints only at
 * 32 nm (the same stamp, so the same voxels): there the overlay holds a single
 * resolution and reads back unambiguously.
 */
test.describe("save: one layer painted at two resolutions", () => {
  const scenario = SCENARIOS.find(
    (candidate) => candidate.name === "multires-seg-target",
  )!;
  const COARSE_RESOLUTION = "32x32x40";
  const FINE_STAMP = { fracX: 0.3, fracY: 0.3 };
  const COARSE_STAMP = { fracX: 0.7, fracY: 0.7 };
  // Fresh storage per test: a saved stroke would change what the next test's
  // overlay counts as painted.
  let storage: Awaited<ReturnType<typeof startStorage>>;

  test.beforeEach(async () => {
    storage = await startStorage(test.info().title);
  });

  test.afterEach(async () => {
    await storage?.dispose();
  });

  const fixture = () => targetFixture(editingFixtures(), scenario);
  const fineRegion = () => regionOf(fixture(), scenario);
  /** The 32 nm scale covers the same volume in half as many voxels in x, y. */
  const coarseRegion = (): { lo: Vec3; hi: Vec3 } => {
    const { lo, hi } = fineRegion();
    return {
      lo: [lo[0] / 2, lo[1] / 2, lo[2]],
      hi: [hi[0] / 2, hi[1] / 2, hi[2]],
    };
  };
  const readCoarse = () =>
    readStoredVolume(storage.webApi.url, {
      layerPath: storagePath(editingFixtures(), fixture()),
      dataType: fixture().dtype as StoredDataType,
      start: coarseRegion().lo,
      end: coarseRegion().hi,
      resolution: fixture().resolutions[1],
    });
  const switchToCoarse = (page: Page) =>
    page.evaluate(
      (resolution) =>
        (window as any).viewer.editSessionHost.painting.state.patchState({
          targetResolution: resolution,
        }),
      COARSE_RESOLUTION,
    );

  /** The coarse stamp painted alone, and the voxels it covers (32 nm grid). */
  async function coarseStampAlone(browser: Browser) {
    const { page } = await openEditingPage(browser, scenario, storage);
    await switchToCoarse(page);
    const painted = await stamp(page, coarseRegion().lo, COARSE_STAMP);
    expect(painted.strokeFired).toBe(true);
    expect(painted.paintedVoxels).toBeGreaterThan(0);
    const voxels = await paintedVoxelMap(page, coarseRegion().lo);
    await page.context().close();
    return { painted, voxels };
  }

  test("each resolution's save writes only that resolution's stroke", async ({
    browser,
  }) => {
    const coarse = await coarseStampAlone(browser);
    const fineBefore = await readTargetRegion(
      storage.webApi,
      fixture(),
      fineRegion(),
    );
    const coarseBefore = await readCoarse();
    const { page, backend } = await openEditingPage(browser, scenario, storage);
    const fine = await stamp(page, fineRegion().lo, FINE_STAMP);
    expect(fine.paintedVoxels).toBeGreaterThan(0);
    await switchToCoarse(page);
    await stamp(page, coarseRegion().lo, COARSE_STAMP);

    const saved = await saveActive(page);
    expect(saved.overall, JSON.stringify(saved.outcomes)).toBe("all-succeeded");
    expect(saved.progress.kind, "read-back verification").toBe("idle");
    expect(saved.unsaved).toBe(false);

    const writtenResolutions = cutoutWrites(backend).map((write) => [
      write.status,
      write.query.getAll("resolution").map(Number).join("x"),
    ]);
    expect(writtenResolutions.sort()).toEqual(
      [
        ...Array(fine.chunkCount).fill([200, "16x16x40"]),
        ...Array(coarse.painted.chunkCount).fill([200, COARSE_RESOLUTION]),
      ].sort(),
    );
    expectStorageHoldsExactly(
      changedVoxels(
        fineBefore,
        await readTargetRegion(storage.webApi, fixture(), fineRegion()),
      ),
      fine,
    );
    expectStorageHoldsExactly(
      changedVoxels(coarseBefore, await readCoarse()),
      coarse.painted,
    );
    await page.context().close();
  });

  /**
   * The view is at 16 nm. Whether a 32 nm stroke shows there at all is open,
   * but if it does, it must cover the 16 nm voxels under the 32 nm voxels it
   * painted — never voxels no stroke touched.
   */
  test("the view shows each stroke only where it was painted", async ({
    browser,
  }) => {
    test.fail(
      true,
      "The overlay keeps one patch store per layer keyed by chunk grid " +
        "position only, so a 32 nm stroke lands in the 16 nm chunk with the " +
        "same index and is drawn at half its coordinates.",
    );
    const coarse = await coarseStampAlone(browser);
    const { page } = await openEditingPage(browser, scenario, storage);
    await stamp(page, fineRegion().lo, FINE_STAMP);
    const fine = await paintedVoxelMap(page, fineRegion().lo);
    await switchToCoarse(page);
    await stamp(page, coarseRegion().lo, COARSE_STAMP);
    const shown = await paintedVoxelMap(page, fineRegion().lo);
    await page.context().close();

    const underCoarse = new Set<string>();
    for (const key of coarse.voxels.keys()) {
      const [x, y, z] = key.split(",").map(Number);
      for (const [offsetX, offsetY] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        underCoarse.add(`${2 * x + offsetX},${2 * y + offsetY},${z}`);
      }
    }
    const nowhere = [...shown.keys()].filter(
      (key) => !fine.has(key) && !underCoarse.has(key),
    );
    expect(nowhere, "painted voxels no stroke touched").toEqual([]);
    const lost = [...fine.keys()].filter((key) => !shown.has(key));
    expect(lost, "16 nm voxels no longer shown").toEqual([]);
  });
});

test.describe("save failures", () => {
  // Fresh storage per test: each must start from the generated fixtures.
  let storage: Awaited<ReturnType<typeof startStorage>>;

  test.beforeEach(async () => {
    storage = await startStorage(test.info().title);
  });

  test.afterEach(async () => {
    await storage?.dispose();
  });

  test("a write the backend acknowledged but storage does not hold stays unconfirmed, never 'saved'", async ({
    browser,
  }) => {
    // Read-back retries with backoff (~24 s) before it gives up.
    test.setTimeout(3 * 60 * 1000);
    const fixture = targetFixture(editingFixtures(), FAILURE_SCENARIO);
    const region = regionOf(fixture, FAILURE_SCENARIO);
    const { page, backend } = await openEditingPage(
      browser,
      FAILURE_SCENARIO,
      storage,
    );
    const before = await readTargetRegion(storage.webApi, fixture, region);
    const painted = await paintOneStamp(page, fixture, region, before);

    backend.failAlways("POST", "/painting/cutout", {
      kind: "acknowledgeWithoutWriting",
    });
    const saved = await saveActive(page);

    // The write itself was acknowledged...
    expect(saved.overall).toBe("all-succeeded");
    // ...but read-back never confirms it, so the save is not reported clean.
    expect(saved.progress).toEqual({
      kind: "failed",
      unconfirmed: painted.chunkCount,
      total: painted.chunkCount,
    });
    expect(saved.unsaved).toBe(true);
    expect(
      changedVoxels(
        before,
        await readTargetRegion(storage.webApi, fixture, region),
      ),
    ).toEqual([]);
    await page.context().close();
  });

  test("a backend outage fails the save and keeps the paint; the next save after recovery persists it", async ({
    browser,
  }) => {
    const fixture = targetFixture(editingFixtures(), FAILURE_SCENARIO);
    const region = regionOf(fixture, FAILURE_SCENARIO);
    const { page, backend } = await openEditingPage(
      browser,
      FAILURE_SCENARIO,
      storage,
    );
    const before = await readTargetRegion(storage.webApi, fixture, region);
    const painted = await paintOneStamp(page, fixture, region, before);

    backend.failAlways("POST", "/painting/cutout", {
      kind: "respond",
      status: 500,
      body: { detail: "e2e: backend outage" },
    });
    const failed = await saveActive(page);
    expect(failed.overall).toBe("all-failed");
    expect(failed.outcomes).toEqual([
      { layerId: fixture.id, status: "failed", errorCode: "save-failed" },
    ]);
    expect(failed.unsaved).toBe(true);
    expect(
      changedVoxels(
        before,
        await readTargetRegion(storage.webApi, fixture, region),
      ),
    ).toEqual([]);

    backend.clearFaults();
    const recovered = await saveActive(page);
    expect(recovered.overall, JSON.stringify(recovered.outcomes)).toBe(
      "all-succeeded",
    );
    expect(recovered.progress.kind).toBe("idle");
    expect(recovered.unsaved).toBe(false);
    expectStorageHoldsExactly(
      changedVoxels(
        before,
        await readTargetRegion(storage.webApi, fixture, region),
      ),
      painted,
    );
    await page.context().close();
  });
});
