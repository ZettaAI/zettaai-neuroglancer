/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * A stroke shows where it was painted whatever pyramid level the viewer
 * draws (TM-524).
 *
 * The target has two resolutions, 16 and 32 nm. Edits are stored at the
 * session's resolution, and the viewer draws whichever level suits the zoom:
 * the same level, a finer one (session at 32 nm, view at 16 nm voxels), or a
 * coarser one (session at 16 nm, zoomed out). Before TM-524 the overlay was
 * looked up by chunk number only, so on any other level the stroke landed at
 * half or twice its coordinates.
 *
 * Each case paints one stamp at a known panel point and checks, on screen,
 * that the pixels that changed sit around that point, and, through the
 * viewer's own value lookup, that the voxel under it holds the painted value.
 */

import { test, expect, type Page } from "@playwright/test";

import type {
  FixturesIndex,
  Scenario,
  Vec3,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  openScenarioPage,
  startFixtureGcs,
  warmupPaintPath,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);
const TARGET = "seg_u64_multires";
/** The target layer's name, whatever its fixture. */
const LAYER_NAME = "target";
const FINE: Vec3 = [16, 16, 40];
const COARSE: Vec3 = [32, 32, 40];
/** The painted segment id (the scenario's default `activeValue`). */
const PAINTED_VALUE = "1";

interface Case {
  readonly name: string;
  /** Target fixture; defaults to `TARGET`. */
  readonly fixtureId?: string;
  readonly sessionResolutions: Vec3[];
  /** The level the viewer must draw for the case to mean what it says. */
  readonly drawnLevel: string;
  readonly crossSectionScale: number;
  /** Where the stamp goes, as a fraction of the panel: inside the data. */
  readonly stampFraction: number;
}

const CASES: Case[] = [
  // A volume smaller than one chunk: the session's chunks are clipped to it
  // (TM-373) while the viewer's chunk grid is not.
  {
    name: "clipped chunks, session coarser than the level drawn",
    fixtureId: "seg_u64_multires_clipped",
    sessionResolutions: [COARSE],
    drawnLevel: "16x16x40",
    crossSectionScale: 0.25,
    stampFraction: 0.6,
  },
  {
    name: "clipped chunks, session finer than the level drawn (zoomed out)",
    fixtureId: "seg_u64_multires_clipped",
    sessionResolutions: [FINE],
    drawnLevel: "32x32x40",
    crossSectionScale: 1.5,
    stampFraction: 0.55,
  },
  {
    name: "session at the level drawn",
    sessionResolutions: [FINE],
    drawnLevel: "16x16x40",
    crossSectionScale: 0.25,
    stampFraction: 0.7,
  },
  {
    name: "session coarser than the level drawn",
    sessionResolutions: [COARSE],
    drawnLevel: "16x16x40",
    crossSectionScale: 0.25,
    stampFraction: 0.7,
  },
  {
    name: "session finer than the level drawn (zoomed out)",
    sessionResolutions: [FINE],
    drawnLevel: "32x32x40",
    crossSectionScale: 1.5,
    stampFraction: 0.55,
  },
  {
    name: "two session resolutions, painting at the coarser",
    sessionResolutions: [COARSE, FINE],
    drawnLevel: "16x16x40",
    crossSectionScale: 0.25,
    stampFraction: 0.7,
  },
];

let fakeGcs: FixtureGcs | undefined;
let fixtures: FixturesIndex | undefined;
let setupError: string | undefined;

test.beforeAll(async () => {
  try {
    fixtures = loadFixturesIndex();
    fakeGcs = await startFixtureGcs();
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  }
});

test.afterAll(async () => {
  await fakeGcs?.[Symbol.asyncDispose]?.();
});

function scenario(testCase: Case): Scenario {
  return {
    name: testCase.name,
    layers: [
      {
        fixtureId: testCase.fixtureId ?? TARGET,
        name: LAYER_NAME,
        role: "target",
        writable: true,
        sessionResolutions: testCase.sessionResolutions,
      },
    ],
    crossSectionScale: testCase.crossSectionScale,
  };
}

/** The data panel's box in page pixels. */
async function panelBox(page: Page) {
  return await page
    .locator(".neuroglancer-rendered-data-panel")
    .first()
    .evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });
}

/**
 * Resolutions of the target levels the viewer is drawing now, from each
 * visible source's chunk→model scale (model units are the finest level).
 */
async function drawnLevels(page: Page): Promise<string[]> {
  const multipliers = (await page.evaluate((layerName) => {
    const viewer = (globalThis as any).viewer;
    const layer = viewer.layerManager.getLayerByName(layerName).layer;
    const levels = new Set<string>();
    for (const renderLayer of layer.renderLayers) {
      for (const { chunkTransform } of renderLayer.visibleSourcesList ?? []) {
        const transform = chunkTransform.chunkToLayerTransform as Float32Array;
        const rank = chunkTransform.layerRank as number;
        levels.add(
          [0, 1, 2]
            .map((axis) => Math.round(transform[axis * (rank + 1) + axis]))
            .join(","),
        );
      }
    }
    return [...levels];
  }, LAYER_NAME)) as string[];
  return multipliers.map((multiplier) =>
    multiplier
      .split(",")
      .map((factor, axis) => Number(factor) * FINE[axis])
      .join("x"),
  );
}

/**
 * The target value the viewer reports at a page point (its CPU lookup, the
 * same one hover and picking use).
 */
async function valueAt(page: Page, pageX: number, pageY: number) {
  await page.mouse.move(pageX, pageY);
  await page.waitForTimeout(300);
  return (await page.evaluate((layerName) => {
    const viewer = (globalThis as any).viewer;
    const layer = viewer.layerManager.getLayerByName(layerName).layer;
    const position = viewer.mouseState.position as Float32Array;
    for (const renderLayer of layer.renderLayers) {
      if (typeof renderLayer.getValueAt !== "function") continue;
      const value = renderLayer.getValueAt(position);
      if (value != null) return String(value);
    }
    return undefined;
  }, LAYER_NAME)) as string | undefined;
}

/** The brush outline follows the mouse: keep it off the data panels. */
async function moveAwayFromPanels(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
) {
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
  await page.waitForTimeout(300);
}

/** Panel pixels as RGBA, decoded in the page. */
async function panelPixels(page: Page) {
  const box = await panelBox(page);
  const png = await page.screenshot({ clip: box, animations: "disabled" });
  const pixels = (await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      data: Array.from(data.data),
    };
  }, png.toString("base64"))) as {
    width: number;
    height: number;
    data: number[];
  };
  return { ...pixels, box };
}

/** Bounding box (page pixels) of the pixels that differ between two shots. */
function changedBox(
  before: Awaited<ReturnType<typeof panelPixels>>,
  after: Awaited<ReturnType<typeof panelPixels>>,
) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const scaleX = before.box.width / before.width;
  const scaleY = before.box.height / before.height;
  for (let y = 0; y < before.height; ++y) {
    for (let x = 0; x < before.width; ++x) {
      const index = (y * before.width + x) * 4;
      const differs =
        Math.abs(before.data[index] - after.data[index]) +
          Math.abs(before.data[index + 1] - after.data[index + 1]) +
          Math.abs(before.data[index + 2] - after.data[index + 2]) >
        24;
      if (!differs) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (left === Infinity) return undefined;
  return {
    left: before.box.x + left * scaleX,
    top: before.box.y + top * scaleY,
    right: before.box.x + (right + 1) * scaleX,
    bottom: before.box.y + (bottom + 1) * scaleY,
  };
}

test.describe("a stroke shows where it was painted at every level", () => {
  for (const testCase of CASES) {
    test(testCase.name, async ({ browser }) => {
      test.skip(setupError !== undefined, setupError);
      const page = await openScenarioPage(browser, {
        scenario: scenario(testCase),
        fixtures: fixtures!,
        fakeGcsUrl: fakeGcs!.url,
        appPort: PORT,
      });
      try {
        await warmupPaintPath(page, { label: testCase.name });
        await page.evaluate(async () => {
          const host = (globalThis as any).viewer.editSessionHost;
          // Only the stroke may change the picture: auto-selecting the
          // painted segment would also light up its baseline voxels.
          host.painting.state.patchState({ autoSelectPaintedSegment: false });
          await (globalThis as any).__editPaintBenchUndoAll();
        });
        await page.waitForTimeout(500);
        expect(await drawnLevels(page)).toContain(testCase.drawnLevel);

        const box = await panelBox(page);
        const stampX = box.x + box.width * testCase.stampFraction;
        const stampY = box.y + box.height * testCase.stampFraction;
        await moveAwayFromPanels(page, box);
        const before = await panelPixels(page);

        const stamp = (await page.evaluate(
          async (fraction) =>
            await (globalThis as any).__editPaintBenchStampReadback({
              radius: 6,
              fracX: fraction,
              fracY: fraction,
              clearFirst: false,
            }),
          testCase.stampFraction,
        )) as { paintedVoxels: number };
        expect(stamp.paintedVoxels).toBeGreaterThan(0);
        await moveAwayFromPanels(page, box);
        await page.waitForTimeout(500);
        const after = await panelPixels(page);

        const changed = changedBox(before, after);
        expect(changed, "the stroke changed nothing on screen").toBeDefined();
        // The stroke is drawn around the stamp point, not at half or twice
        // its coordinates.
        expect(changed!.left).toBeLessThan(stampX);
        expect(changed!.right).toBeGreaterThan(stampX);
        expect(changed!.top).toBeLessThan(stampY);
        expect(changed!.bottom).toBeGreaterThan(stampY);
        const maxReach = box.width * 0.25;
        expect(stampX - changed!.left).toBeLessThan(maxReach);
        expect(changed!.right - stampX).toBeLessThan(maxReach);

        expect(await valueAt(page, stampX, stampY)).toBe(PAINTED_VALUE);
      } finally {
        await page.context().close();
      }
    });
  }
});
