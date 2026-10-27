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
 * Live 3D painted-volume preview CPU benchmark (TM-490, plan §9.3).
 *
 * The 2D patch cache uploads lazily, only what is drawn; the preview
 * composites and uploads eagerly on every change, so it is a cost of its own.
 * This measures it through the `paintProfiler` keys the preview records:
 *
 *   7.preview.regionFill   one call per frame of background region fill
 *   7.preview.occupancy    composite kernel, per chunk box
 *   7.preview.upload       texture sub-upload, per chunk box
 *
 * Targets (plan §9.3): occupancy + upload ≤ 2 ms for a typical stroke; no
 * region-fill frame over 50 ms. Chromium runs on SwiftShader here, so upload
 * is a CPU emulation and GPU frame time is not measured at all — that is a
 * manual measurement on real hardware.
 *
 * ⚠ Benchmark, not a gating test: a test is red only when nothing was
 * measured. The numbers go to `test-results/edit_painted_volume_perf.json`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import type {
  FixturesIndex,
  Scenario,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  openScenarioPage,
  startFixtureGcs,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);

const TARGET = "seg";
const PERF_SCENARIO: Scenario = {
  name: "perf: painted-volume preview",
  crossSectionScale: 2.0,
  layers: [
    {
      fixtureId: "perf_seg_u64_cseg",
      role: "target",
      writable: true,
      name: TARGET,
    },
  ],
  tooling: {
    activeToolId: "painting.brush",
    painting: {
      targetLayerId: TARGET,
      targetResolution: "16x16x40",
      radius: 25,
      activeValue: { t: "b", v: "1" },
      eraseValue: { t: "b", v: "0" },
      mask: null,
    },
  },
};

const PREVIEW_KEYS = [
  "7.preview.regionFill",
  "7.preview.occupancy",
  "7.preview.upload",
] as const;
/** Brush diameters: typical, large, and the ~1M-voxel stamp of §9.3. */
const STROKE_SIZES = [51, 251, 1025];
const SETTLE_TIMEOUT_MS = 60_000;

interface Bucket {
  readonly totalMs: number;
  readonly calls: number;
  readonly maxMs: number;
}

interface PreviewMeasurement {
  readonly label: string;
  readonly wallMs: number;
  readonly buckets: Record<string, Bucket>;
}

let page: Page;
let fakeGcs: FixtureGcs | undefined;
let fixtures: FixturesIndex | undefined;
let setupError: string | undefined;
const measurements: PreviewMeasurement[] = [];

try {
  fixtures = loadFixturesIndex();
} catch (e) {
  setupError = e instanceof Error ? e.message : String(e);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(8 * 60 * 1000);
  if (setupError !== undefined) return;
  try {
    fakeGcs = await startFixtureGcs();
    page = await openScenarioPage(browser, {
      scenario: PERF_SCENARIO,
      fixtures: fixtures!,
      fakeGcsUrl: fakeGcs.url,
      appPort: PORT,
    });
    await page.evaluate(() => {
      (globalThis as any).viewer.editSessionHost.selectTool("painting.brush");
    });
    // A first stroke pays for chunk loads and shader compiles.
    await page.waitForTimeout(1500);
    await strokeAcrossPanel(page);
    await clearPatches(page);
  } catch (e) {
    setupError = e instanceof Error ? e.message : String(e);
  }
});

test.afterAll(async () => {
  if (measurements.length > 0) {
    mkdirSync("test-results", { recursive: true });
    writeFileSync(
      path.join("test-results", "edit_painted_volume_perf.json"),
      JSON.stringify(measurements, null, 2),
    );
  }
  await page?.close().catch(() => {});
  await fakeGcs?.[Symbol.asyncDispose]?.();
});

test("region fill on toggle", async () => {
  test.skip(setupError !== undefined, `setup failed: ${setupError}`);
  const measurement = await measure(page, "region fill", async () => {
    await page
      .getByRole("button", { name: "Show painted voxels in 3D" })
      .click();
    await waitForRegionFilled(page);
  });
  await report(measurement);
  const fill = measurement.buckets["7.preview.regionFill"];
  expect(fill?.calls ?? 0, "the region fill recorded no frame").toBeGreaterThan(
    0,
  );
  console.log(
    `[preview-perf] region fill: ${measurement.wallMs.toFixed(0)} ms total, ` +
      `${fill.calls} frames, worst frame ${fill.maxMs.toFixed(1)} ms ` +
      `(target ≤ 50 ms)`,
  );
});

for (const previewEnabled of [true, false]) {
  test.describe(`stroke, preview ${previewEnabled ? "on" : "off"}`, () => {
    for (const size of STROKE_SIZES) {
      test(`brush ${size}`, async () => {
        test.skip(setupError !== undefined, `setup failed: ${setupError}`);
        await setPreviewEnabled(page, previewEnabled);
        await setBrushRadius(page, (size - 1) / 2);
        await clearPatches(page);
        const measurement = await measure(
          page,
          `brush ${size}, preview ${previewEnabled ? "on" : "off"}`,
          () => strokeAcrossPanel(page),
        );
        await report(measurement);
        const occupancy = measurement.buckets["7.preview.occupancy"];
        const upload = measurement.buckets["7.preview.upload"];
        if (!previewEnabled) {
          expect(occupancy, "the preview worked while off").toBeUndefined();
          return;
        }
        expect(occupancy?.calls ?? 0, "no occupancy recorded").toBeGreaterThan(
          0,
        );
        console.log(
          `[preview-perf] brush ${size}: occupancy ` +
            `${occupancy.totalMs.toFixed(2)} ms + upload ` +
            `${(upload?.totalMs ?? 0).toFixed(2)} ms ` +
            `(target ≤ 2 ms for a typical stroke)`,
        );
      });
    }
  });
}

// --- Page helpers -------------------------------------------------------

/** Run `action` with the profiler on; keep its preview keys and long tasks. */
async function measure(
  page: Page,
  label: string,
  action: () => Promise<void>,
): Promise<PreviewMeasurement> {
  await page.evaluate(() => {
    const profiler = (globalThis as any).__paintProfiler;
    profiler.enabled = true;
    profiler.resetWindow();
  });
  const start = Date.now();
  await action();
  const wallMs = Date.now() - start;
  const buckets = await page.evaluate(() => {
    const profiler = (globalThis as any).__paintProfiler;
    const snapshot = profiler.snapshot();
    profiler.enabled = false;
    profiler.resetWindow();
    return snapshot.buckets as Record<string, Bucket>;
  });
  const kept: Record<string, Bucket> = {};
  for (const key of [...PREVIEW_KEYS, "mt.longtask(>50ms)"]) {
    if (buckets[key] !== undefined) kept[key] = buckets[key];
  }
  const measurement = { label, wallMs, buckets: kept };
  measurements.push(measurement);
  return measurement;
}

async function report(measurement: PreviewMeasurement): Promise<void> {
  await test.info().attach(`${measurement.label}.json`, {
    body: JSON.stringify(measurement, null, 2),
    contentType: "application/json",
  });
}

/** A left-to-right drag through the xy panel's centre, then settle. */
async function strokeAcrossPanel(page: Page): Promise<void> {
  const box = await page.evaluate(() => {
    const rect = document
      .querySelector(".neuroglancer-rendered-data-panel")!
      .getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const centerY = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, centerY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, centerY, { steps: 20 });
  await page.mouse.up();
  await page.mouse.move(0, 0);
  await waitForPaintStable(page);
  await nextFrames(page, 4);
}

async function waitForPaintStable(page: Page): Promise<void> {
  let previous = -1;
  await expect
    .poll(
      async () => {
        const painted = await page.evaluate(
          () => (globalThis as any).__editPaintBenchReadback({}).paintedVoxels,
        );
        const stable = painted > 0 && painted === previous;
        previous = painted;
        return stable;
      },
      { timeout: SETTLE_TIMEOUT_MS, intervals: [100] },
    )
    .toBe(true);
}

async function waitForRegionFilled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const summary = (globalThis as any).viewer.editSessionHost
            .paintedVolumePreviewSummary.value;
          if (summary.kind !== "live") return summary.kind;
          const { done, total } = summary.fill;
          return total > 0 && done === total ? "filled" : "filling";
        }),
      { timeout: SETTLE_TIMEOUT_MS, intervals: [50] },
    )
    .toBe("filled");
  await nextFrames(page, 2);
}

async function setPreviewEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((value) => {
    (globalThis as any).viewer.editSessionHost.setPaintedVolumePreviewEnabled(
      value,
    );
  }, enabled);
  if (enabled) await waitForRegionFilled(page);
}

async function setBrushRadius(page: Page, radius: number): Promise<void> {
  await page.evaluate((value) => {
    (globalThis as any).viewer.editSessionHost.painting.state.patchState({
      radius: value,
    });
  }, radius);
  await nextFrames(page, 2);
}

/** Clearing makes a live preview refill the region; wait it out. */
async function clearPatches(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as any).__editPaintBenchClearTarget());
  await nextFrames(page, 2);
  const previewLive = await page.evaluate(
    () =>
      (globalThis as any).viewer.editSessionHost.paintedVolumePreviewSummary
        .value.kind === "live",
  );
  if (previewLive) await waitForRegionFilled(page);
}

async function nextFrames(page: Page, frames: number): Promise<void> {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, frames);
}
