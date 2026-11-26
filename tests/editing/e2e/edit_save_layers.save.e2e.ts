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
 * Sessions with several layers, end to end (TM-366): one or two writable
 * targets beside zero to two locked reference images.
 *
 * - Every session layer, writable or locked, is locked in the layer bar.
 * - Strokes go to the target picked in the brush panel; each writable layer's
 *   overlay and storage hold only its own stroke.
 * - A save writes only writable layers, and reports one outcome per writable
 *   layer: a failure on one of two is `partial`, and the next save writes only
 *   the layer that failed.
 *
 * `locked_writable_matrix.spec.ts` sweeps the same counts through the session
 * seams in memory; this runs them through the real app, web API and storage.
 */

import { test, expect, type Page } from "@playwright/test";

import type {
  Scenario,
  ScenarioLayer,
} from "#tests/editing/harness/build_ng_state.js";
import {
  layerBarDeleteIcon,
  SESSION_LAYER_LOCK_REASON,
} from "#tests/editing/harness/layer_bar.js";
import {
  chooseTargetLayer,
  cutoutWrites,
  editingFixtures,
  expectStorageHoldsExactly,
  openEditingPage,
  type PaintedSummary,
  readTargetRegion,
  regionOf,
  saveActive,
  stampAtVoxel,
  startStorage,
  storagePath,
} from "#tests/editing/harness/save_session.js";
import { changedVoxels } from "#tests/editing/harness/storage_oracle.js";

/** Writable targets over the same 128×128×16 volume, with what each paints. */
const WRITABLE = [
  { fixtureId: "seg_u64_cseg", at: [40, 40], value: 100 },
  { fixtureId: "seg_u64_multires", at: [88, 88], value: 103 },
] as const;
type WritableTarget = (typeof WRITABLE)[number];
/** Locked reference images over the same volume. */
const LOCKED = ["img_u8_raw", "mask_features_u8"] as const;
const RADIUS = 6;

function scenarioWith(writableCount: number, lockedCount: number): Scenario {
  const layers: ScenarioLayer[] = [
    ...LOCKED.slice(0, lockedCount).map((fixtureId) => ({
      fixtureId,
      role: "image" as const,
      writable: false,
    })),
    ...WRITABLE.slice(0, writableCount).map(({ fixtureId }) => ({
      fixtureId,
      role: "target" as const,
      writable: true,
    })),
  ];
  return {
    name: `${writableCount} writable + ${lockedCount} locked`,
    layers,
  };
}

const fixtureOf = (fixtureId: string) =>
  editingFixtures().fixtures.find((fixture) => fixture.id === fixtureId)!;

const readLayer = (
  storage: Awaited<ReturnType<typeof startStorage>>,
  fixtureId: string,
) =>
  readTargetRegion(
    storage.webApi,
    fixtureOf(fixtureId),
    regionOf(fixtureOf(fixtureId), {
      name: fixtureId,
      layers: [{ fixtureId, role: "target", writable: true }],
    }),
  );

/** Paint each writable layer's own dab, picking it as the target first. */
async function paintEachTarget(
  page: Page,
  targets: readonly WritableTarget[],
): Promise<Map<string, PaintedSummary>> {
  const painted = new Map<string, PaintedSummary>();
  for (const { fixtureId, at, value } of targets) {
    if (targets.length > 1) await chooseTargetLayer(page, fixtureId);
    const summary = await stampAtVoxel(page, at, {
      layerId: fixtureId,
      originOffset: fixtureOf(fixtureId).offset,
      radius: RADIUS,
      value,
    });
    expect(summary.paintedVoxels, fixtureId).toBeGreaterThan(0);
    expect(summary.distinctValues, fixtureId).toEqual([String(value)]);
    painted.set(fixtureId, summary);
  }
  return painted;
}

const readBack = (page: Page, fixtureId: string) =>
  page.evaluate(
    ({ layerId, originOffset }) =>
      (window as any).__editPaintBenchReadback({
        layerId,
        originOffset,
      }) as PaintedSummary,
    { layerId: fixtureId, originOffset: [...fixtureOf(fixtureId).offset] },
  );

for (const [writableCount, lockedCount] of [
  [1, 0],
  [1, 2],
  [2, 0],
  [2, 2],
] as const) {
  const scenario = scenarioWith(writableCount, lockedCount);
  const targets = WRITABLE.slice(0, writableCount);

  test.describe(`save: ${scenario.name}`, () => {
    let storage: Awaited<ReturnType<typeof startStorage>>;

    test.beforeEach(async () => {
      storage = await startStorage(scenario.name);
    });

    test.afterEach(async () => {
      await storage?.dispose();
    });

    test("every session layer is locked; each target keeps its own stroke; only writable layers are saved", async ({
      browser,
    }) => {
      const before = new Map(
        await Promise.all(
          targets.map(
            async ({ fixtureId }) =>
              [fixtureId, await readLayer(storage, fixtureId)] as const,
          ),
        ),
      );
      const { page, backend } = await openEditingPage(
        browser,
        scenario,
        storage,
      );
      for (const { fixtureId } of scenario.layers) {
        const icon = await layerBarDeleteIcon(page, fixtureId);
        await expect(icon, fixtureId).toHaveAttribute("aria-disabled", "true");
        await expect(icon, fixtureId).toHaveAttribute(
          "title",
          SESSION_LAYER_LOCK_REASON,
        );
      }

      const painted = await paintEachTarget(page, targets);
      // Painting the next target left every earlier one's overlay as it was.
      for (const { fixtureId } of targets) {
        expect(await readBack(page, fixtureId), fixtureId).toEqual(
          painted.get(fixtureId),
        );
      }

      const saved = await saveActive(page);
      expect(saved.overall, JSON.stringify(saved.outcomes)).toBe(
        "all-succeeded",
      );
      expect(saved.outcomes.map((outcome) => outcome.layerId).sort()).toEqual(
        targets.map(({ fixtureId }) => fixtureId).sort(),
      );
      expect(saved.progress.kind, "read-back verification").toBe("idle");
      expect(saved.unsaved).toBe(false);

      const writtenPaths = new Set(
        cutoutWrites(backend).map((write) => write.query.get("path")),
      );
      expect(writtenPaths).toEqual(
        new Set(
          targets.map(({ fixtureId }) =>
            storagePath(editingFixtures(), fixtureOf(fixtureId)),
          ),
        ),
      );
      for (const { fixtureId, value } of targets) {
        expectStorageHoldsExactly(
          changedVoxels(
            before.get(fixtureId)!,
            await readLayer(storage, fixtureId),
          ),
          painted.get(fixtureId)!,
          value,
        );
      }
      await page.context().close();
    });
  });
}

test.describe("save: one of two targets fails", () => {
  const scenario = scenarioWith(2, 1);
  const [kept, failing] = WRITABLE;
  let storage: Awaited<ReturnType<typeof startStorage>>;

  test.beforeEach(async () => {
    storage = await startStorage(scenario.name);
  });

  test.afterEach(async () => {
    await storage?.dispose();
  });

  test("the save is partial, keeps the failed layer's paint, and the next save writes only that layer", async ({
    browser,
  }) => {
    const keptBefore = await readLayer(storage, kept.fixtureId);
    const failingBefore = await readLayer(storage, failing.fixtureId);
    const { page, backend } = await openEditingPage(browser, scenario, storage);
    const painted = await paintEachTarget(page, WRITABLE);
    const failingPath = storagePath(
      editingFixtures(),
      fixtureOf(failing.fixtureId),
    );

    backend.failAlways(
      "POST",
      "/painting/cutout",
      { kind: "respond", status: 500, body: { detail: "e2e: layer outage" } },
      { path: failingPath },
    );
    const first = await saveActive(page);
    expect(first.overall).toBe("partial");
    expect(
      [...first.outcomes].sort((a, b) => a.layerId.localeCompare(b.layerId)),
    ).toEqual(
      [
        { layerId: kept.fixtureId, status: "succeeded" },
        {
          layerId: failing.fixtureId,
          status: "failed",
          errorCode: "save-failed",
        },
      ].sort((a, b) => a.layerId.localeCompare(b.layerId)),
    );
    expect(first.unsaved).toBe(true);
    expectStorageHoldsExactly(
      changedVoxels(keptBefore, await readLayer(storage, kept.fixtureId)),
      painted.get(kept.fixtureId)!,
      kept.value,
    );
    expect(
      changedVoxels(failingBefore, await readLayer(storage, failing.fixtureId)),
    ).toEqual([]);
    expect(await readBack(page, failing.fixtureId)).toEqual(
      painted.get(failing.fixtureId),
    );

    backend.clearFaults();
    const writesBefore = cutoutWrites(backend).length;
    const second = await saveActive(page);
    expect(second.overall, JSON.stringify(second.outcomes)).toBe(
      "all-succeeded",
    );
    expect(second.progress.kind).toBe("idle");
    expect(second.unsaved).toBe(false);
    const secondWrites = cutoutWrites(backend).slice(writesBefore);
    expect(
      secondWrites.map((write) => [write.query.get("path"), write.status]),
    ).toEqual(
      Array(painted.get(failing.fixtureId)!.chunkCount).fill([
        failingPath,
        200,
      ]),
    );
    expectStorageHoldsExactly(
      changedVoxels(failingBefore, await readLayer(storage, failing.fixtureId)),
      painted.get(failing.fixtureId)!,
      failing.value,
    );
    expectStorageHoldsExactly(
      changedVoxels(keptBefore, await readLayer(storage, kept.fixtureId)),
      painted.get(kept.fixtureId)!,
      kept.value,
    );
    await page.context().close();
  });
});
