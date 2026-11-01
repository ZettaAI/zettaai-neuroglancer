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
 * Edit-session paint CORRECTNESS e2e (TM-331, phase 2 capstone).
 *
 * Wires together the whole phase-2 stack: generated precomputed fixtures →
 * local `fake-gcs-server` → GCS route-rewrite → `buildNgState` scenario → the
 * built app auto-opens the session → a DETERMINISTIC stamp through the full
 * stack → `__editPaintBench` READ-BACK → assert what got painted.
 *
 * Unlike the perf bench this needs no live `gs://` auth and is reproducible: the
 * data is generated from `manifest.json` and served locally. Each scenario loads
 * its own ngState (so the offset / encoding / multi-res axes are exercised
 * end-to-end — the axes the in-memory matrix can't reach).
 *
 * Setup that can't be satisfied offline (missing prod build, ungenerated
 * fixtures, no WebGL2) fails fast in `beforeAll` and SKIPS the asserts with a
 * clear reason — run `npm run e2e`.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test, expect, type Page } from "@playwright/test";

import {
  type FixturesIndex,
  type Scenario,
  type Vec3,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  openScenarioPage,
  startFixtureGcs,
  warmupPaintPath,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);
const HERE = path.dirname(fileURLToPath(import.meta.url));

interface ReadbackShape {
  targetLayerId: unknown;
  error?: string;
  paintedVoxels: number;
  chunkCount: number;
  bbox: { lo: Vec3; hi: Vec3 } | null;
  signature: string;
  distinctValues: string[];
  strokeFired: boolean;
}

// Scenarios — each loads its own state so a different data axis is exercised.
const SCENARIOS: ReadonlyArray<{
  scenario: Scenario;
  /** True when the scenario carries an image layer (enables the masked case). */
  hasImage: boolean;
}> = [
  {
    hasImage: true,
    scenario: {
      name: "img-locked + cseg-target",
      layers: [
        { fixtureId: "img_u8_raw", role: "image", writable: false },
        { fixtureId: "seg_u64_cseg", role: "target", writable: true },
      ],
    },
  },
  {
    hasImage: false,
    scenario: {
      name: "offset-seg-target",
      layers: [
        { fixtureId: "seg_u32_raw_offset", role: "target", writable: true },
      ],
    },
  },
];

let fixtures: FixturesIndex | undefined;
let fakeGcs: FixtureGcs | undefined;
let topSetupError: string | undefined;

try {
  fixtures = loadFixturesIndex();
} catch (e) {
  topSetupError = e instanceof Error ? e.message : String(e);
}

test.beforeAll(async () => {
  if (topSetupError !== undefined) return;
  try {
    fakeGcs = await startFixtureGcs();
  } catch (e) {
    topSetupError = `fake-gcs boot failed: ${e instanceof Error ? e.message : e}`;
  }
});

test.afterAll(async () => {
  await fakeGcs?.[Symbol.asyncDispose]?.();
});

/** Region [lo, hi) for a scenario's target fixture (offset … offset+size). */
function regionOf(
  index: FixturesIndex,
  scenario: Scenario,
): { lo: Vec3; hi: Vec3 } {
  const targetLayer = scenario.layers.find((l) => l.role === "target")!;
  const fx = index.fixtures.find((f) => f.id === targetLayer.fixtureId)!;
  const size = scenario.regionSize ?? fx.size;
  return {
    lo: fx.offset,
    hi: [
      fx.offset[0] + size[0],
      fx.offset[1] + size[1],
      fx.offset[2] + size[2],
    ],
  };
}

function within(bbox: { lo: Vec3; hi: Vec3 }, region: { lo: Vec3; hi: Vec3 }) {
  for (let d = 0; d < 3; d++) {
    if (bbox.lo[d] < region.lo[d]) return false;
    if (bbox.hi[d] > region.hi[d]) return false;
  }
  return true;
}

async function stamp(
  page: Page,
  input: Record<string, unknown>,
): Promise<ReadbackShape> {
  return (await page.evaluate(
    async (arg) => await (window as any).__editPaintBenchStampReadback(arg),
    input,
  )) as ReadbackShape;
}

/**
 * Remove earlier tests' paint from the overlay. `clearFirst` only drops the GPU
 * patches, so their voxels come back as soon as a stroke rewrites their chunk,
 * and a read-back then counts them too.
 */
const undoAllPaint = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const session = (window as any).viewer.editSessionHost.activeSession.value;
    while ((await session.undo()) !== undefined);
  });

const strokeIsLive = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).viewer.editSessionHost.hasLiveEdit);

/** A viewport point over no panel, for a release that only the window sees. */
function findPointOffPanels(): { x: number; y: number } | null {
  const STEP_PX = 8;
  for (let y = 1; y < window.innerHeight; y += STEP_PX) {
    for (let x = 1; x < window.innerWidth; x += STEP_PX) {
      const element = document.elementFromPoint(x, y);
      if (element !== null && element.closest(".neuroglancer-panel") === null) {
        return { x, y };
      }
    }
  }
  return null;
}

/** Press and drag with the real mouse, so the browser picks the event targets. */
async function beginRealStroke(page: Page): Promise<{ x: number; y: number }> {
  const center = await page.evaluate(() => {
    const host = (window as any).viewer.editSessionHost;
    host.painting.state.patchState({ radius: 2, mask: undefined });
    host.selectTool("painting.brush");
    const canvases = Array.from(document.querySelectorAll("canvas"));
    const largest = canvases.reduce((best, canvas) =>
      canvas.width * canvas.height > best.width * best.height ? canvas : best,
    );
    const rect = largest.getBoundingClientRect();
    return { x: rect.left + rect.width / 4, y: rect.top + rect.height / 4 };
  });
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 20, center.y + 20, { steps: 4 });
  await expect.poll(() => strokeIsLive(page)).toBe(true);
  return center;
}

const SHOT_DIR = path.resolve(HERE, "../../../test-results/correctness");

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * Screenshot the largest canvas (the slice view) to `test-results/correctness/`
 * and attach it to the Playwright report so it's reviewable in `--ui` / HTML.
 */
async function shotCanvas(page: Page, label: string): Promise<string> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${label}.png`);
  const clip = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    let best: DOMRect | null = null;
    let area = 0;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area) {
        area = a;
        best = r;
      }
    }
    return best
      ? { x: best.x, y: best.y, width: best.width, height: best.height }
      : null;
  });
  await page.screenshot({
    path: file,
    clip: clip ?? undefined,
    animations: "disabled",
  });
  await test.info().attach(label, { path: file, contentType: "image/png" });
  return file;
}

for (const { scenario, hasImage } of SCENARIOS) {
  test.describe(scenario.name, () => {
    let page: Page;
    let region: { lo: Vec3; hi: Vec3 };
    let scenarioError: string | undefined;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(7 * 60 * 1000);
      if (topSetupError !== undefined) {
        scenarioError = topSetupError;
        return;
      }
      try {
        region = regionOf(fixtures!, scenario);
        page = await openScenarioPage(browser, {
          scenario,
          fixtures: fixtures!,
          fakeGcsUrl: fakeGcs!.url,
          appPort: PORT,
        });
        await warmupPaintPath(page, { label: scenario.name });
      } catch (e) {
        scenarioError = e instanceof Error ? e.message : String(e);
      }
    });

    test.afterAll(async () => {
      await page?.close().catch(() => {});
    });

    // FIRST so a headed/UI run surfaces the visual evidence up front. Saves a
    // before + after PNG of the slice canvas for manual review, then fails loudly
    // if nothing was actually painted (pointer-dispatch / camera regression).
    test("VISUAL: before/after a large stamp (screenshots for manual review)", async () => {
      test.skip(scenarioError !== undefined, scenarioError);
      const id = slug(scenario.name);
      // Let the base image settle so "before" shows the data, not a grey load.
      await page.waitForTimeout(1500);
      const before = await shotCanvas(page, `${id}-1-before`);

      // A big, solid stamp at the panel centre — unmistakable if it lands.
      // Page is already warmed in openScenario, so no extra priming needed.
      const r = await stamp(page, {
        masked: false,
        radius: 32,
        prime: 0,
        clearFirst: true,
        originOffset: region.lo,
      });
      // Give the overlay time to upload + a frame to draw (headed renders).
      await page.waitForTimeout(2000);
      const after = await shotCanvas(page, `${id}-2-after`);
      // Full-page shot too (whole UI), in case the canvas clip misses context.
      const full = path.join(SHOT_DIR, `${id}-3-after-fullpage.png`);
      await page.screenshot({ path: full, fullPage: true });
      await test.info().attach(`${id}-3-after-fullpage`, {
        path: full,
        contentType: "image/png",
      });

      console.log(
        `[visual] ${scenario.name}: painted=${r.paintedVoxels} ` +
          `bbox=${JSON.stringify(r.bbox)} values=${JSON.stringify(
            r.distinctValues,
          )} sig=${r.signature} fired=${r.strokeFired}` +
          (r.error ? ` error=${r.error}` : ""),
      );
      console.log(
        `[visual] screenshots (review these):\n  before:   ${before}\n` +
          `  after:    ${after}\n  fullpage: ${full}`,
      );

      expect(
        r.paintedVoxels,
        "stamp painted NOTHING — pointer dispatch or camera framing is off " +
          "(compare the before/after PNGs in test-results/correctness/)",
      ).toBeGreaterThan(0);
    });

    // `originOffset: region.lo` reports read-back coords as ABSOLUTE global
    // voxels (the patch store is offset-relative), so the bbox is comparable to
    // the absolute edit region — this is what end-to-end-validates the offset axis.
    const paint = (extra: Record<string, unknown>) =>
      stamp(page, { radius: 8, originOffset: region.lo, ...extra });

    test("unmasked brush paints value 1 inside the edit region", async () => {
      test.skip(scenarioError !== undefined, scenarioError);
      const r = await paint({ masked: false, clearFirst: true });
      expect(r.error ?? "", `readback error: ${r.error}`).toBe("");
      expect(r.strokeFired, "stroke did not register").toBe(true);
      expect(r.paintedVoxels).toBeGreaterThan(0);
      // Default tooling paints active value "1".
      expect(r.distinctValues).toEqual(["1"]);
      expect(r.bbox, "no painted bbox").not.toBeNull();
      expect(
        within(r.bbox!, region),
        `bbox ${JSON.stringify(r.bbox)} escaped region ${JSON.stringify(region)}`,
      ).toBe(true);
    });

    test("a repeated identical stamp yields the same signature (deterministic)", async () => {
      test.skip(scenarioError !== undefined, scenarioError);
      const a = await paint({ masked: false, clearFirst: true });
      const b = await paint({ masked: false, clearFirst: true });
      console.log(
        `[determinism] ${scenario.name}: ` +
          `a={n:${a.paintedVoxels},bbox:${JSON.stringify(a.bbox)},sig:${a.signature}} ` +
          `b={n:${b.paintedVoxels},bbox:${JSON.stringify(b.bbox)},sig:${b.signature}}`,
      );
      expect(a.paintedVoxels).toBe(b.paintedVoxels);
      expect(a.signature).toBe(b.signature);
      expect(a.signature).toMatch(/^[0-9a-f]{8}$/);
    });

    test("a closed stroke fills its interior only with the setting on (TM-268)", async () => {
      test.skip(scenarioError !== undefined, scenarioError);
      const loop = {
        masked: false,
        radius: 2,
        closedLoopRadiusPx: 60,
        clearFirst: true,
      };
      await undoAllPaint(page);
      const outline = await paint({ ...loop, fillClosedPaths: false });
      await undoAllPaint(page);
      const filled = await paint({ ...loop, fillClosedPaths: true });
      expect(filled.error ?? "", `readback error: ${filled.error}`).toBe("");
      expect(outline.paintedVoxels).toBeGreaterThan(0);
      expect(filled.paintedVoxels).toBeGreaterThan(outline.paintedVoxels * 2);
      expect(filled.distinctValues).toEqual(["1"]);
      expect(
        within(filled.bbox!, region),
        `bbox ${JSON.stringify(filled.bbox)} escaped region ${JSON.stringify(region)}`,
      ).toBe(true);
    });

    for (const release of ["off every panel", "with Ctrl held"] as const) {
      test(`a stroke released ${release} ends and leaves undo usable (TM-268)`, async () => {
        test.skip(scenarioError !== undefined, scenarioError);
        await paint({ masked: false, clearFirst: true });
        const center = await beginRealStroke(page);
        if (release === "off every panel") {
          const offPanel = await page.evaluate(findPointOffPanels);
          expect(offPanel, "no point outside the panels").not.toBeNull();
          await page.mouse.move(offPanel!.x, offPanel!.y);
          await page.mouse.up();
        } else {
          await page.keyboard.down("Control");
          await page.mouse.up();
          await page.keyboard.up("Control");
        }
        await expect.poll(() => strokeIsLive(page)).toBe(false);
        // Hovering back over the panel must not reopen or extend the stroke.
        await page.mouse.move(center.x + 30, center.y + 30, { steps: 5 });
        expect(await strokeIsLive(page)).toBe(false);
        expect(
          await page.evaluate(() =>
            (window as any).viewer.editSessionHost.refuseWhilePainting(),
          ),
        ).toBe(false);
      });
    }

    test("a stroke started before the last one settled stays its own stroke (TM-268)", async () => {
      test.skip(scenarioError !== undefined, scenarioError);
      await paint({ masked: false, clearFirst: true });
      await undoAllPaint(page);
      await page.evaluate(() => {
        const host = (window as any).viewer.editSessionHost;
        host.selectTool("painting.brush");
        host.painting.state.patchState({
          radius: 2,
          mask: undefined,
          fillClosedPaths: true,
        });
        const panel = document.querySelector(
          ".neuroglancer-rendered-data-panel",
        )!;
        const rect = panel.getBoundingClientRect();
        const fire = (type: string, x: number, y: number) =>
          panel.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 1,
              isPrimary: true,
              bubbles: true,
              clientX: rect.left + x,
              clientY: rect.top + y,
              button: type === "pointermove" ? -1 : 0,
              buttons: type === "pointerup" ? 0 : 1,
            }),
          );
        // All in one tick, so the first stroke is still running when the second
        // one is pressed.
        fire("pointerdown", 60, 60);
        fire("pointermove", 90, 60);
        fire("pointerup", 90, 60);
        fire("pointerdown", 150, 150);
        fire("pointermove", 180, 150);
        fire("pointerup", 180, 150);
      });
      await expect.poll(() => strokeIsLive(page)).toBe(false);
      await page.waitForTimeout(500);
      await expect.poll(() => strokeIsLive(page)).toBe(false);
      const strokes = await page.evaluate(async () => {
        const host = (window as any).viewer.editSessionHost;
        host.painting.state.patchState({ fillClosedPaths: false });
        let entries = 0;
        while ((await host.activeSession.value.undo()) !== undefined) entries++;
        return entries;
      });
      expect(strokes).toBe(2);
    });

    test("Ctrl+drag with the brush pans and does not paint (TM-268)", async () => {
      test.skip(scenarioError !== undefined, scenarioError);
      await undoAllPaint(page);
      await paint({ masked: false, clearFirst: true });
      await undoAllPaint(page);
      const center = await page.evaluate(() => {
        const host = (window as any).viewer.editSessionHost;
        host.selectTool("painting.brush");
        host.painting.state.patchState({ radius: 2, mask: undefined });
        const rect = document
          .querySelector(".neuroglancer-rendered-data-panel")!
          .getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      const viewerPosition = () =>
        page.evaluate(() =>
          Array.from((window as any).viewer.position.value as Float32Array),
        );
      const before = await viewerPosition();
      await page.mouse.move(center.x, center.y);
      await page.keyboard.down("Control");
      await page.mouse.down();
      await page.mouse.move(center.x + 40, center.y + 40, { steps: 4 });
      expect(await strokeIsLive(page)).toBe(false);
      await page.mouse.up();
      await page.keyboard.up("Control");
      expect(await viewerPosition()).not.toEqual(before);
      expect(await strokeIsLive(page)).toBe(false);
      await page.evaluate((position) => {
        (window as any).viewer.position.value = Float32Array.from(position);
      }, before);
    });

    test("erase after paint records erase patches (value 0)", async () => {
      test.skip(scenarioError !== undefined, scenarioError);
      await paint({ masked: false, clearFirst: true });
      const erased = await paint({ erase: true, clearFirst: false });
      expect(erased.distinctValues).toContain("0");
    });

    if (hasImage) {
      test("masked brush (full band) paints inside the region", async () => {
        test.skip(scenarioError !== undefined, scenarioError);
        const r = await paint({ masked: true, clearFirst: true });
        expect(r.error ?? "").toBe("");
        expect(r.paintedVoxels).toBeGreaterThan(0);
        expect(within(r.bbox!, region)).toBe(true);
      });
    }
  });
}
