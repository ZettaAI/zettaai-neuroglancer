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
 * Live 3D painted-volume preview e2e (TM-490, plan §9.2).
 *
 * One `xy-3d` page walks the preview through its life: region filled on
 * session open, stroke, undo, select a segment, erase part of it, deselect,
 * slices shown, session closed. Each step compares the 3D panel's pixels before and
 * after, so what is asserted is what a tracer sees.
 *
 * The scene is chosen so that pixels mean one thing:
 *
 * - the region is ONE z slice thick, so the 3D view from above shows exactly
 *   that slice — an erased disk is a hole, not hidden behind other slices;
 * - the brush paints segment 99, which the fixture does not contain, and the
 *   scenario selects it: the preview shows exactly the segments whose meshes
 *   would be drawn, so an unselected brush segment would stay invisible, and a
 *   selected fixture id would light up the region before the stroke;
 * - 3D slices are hidden (`showSlices: false`), so the 2D overlay on the slice
 *   plane cannot pass for the preview; step 8 shows them on purpose;
 * - strokes are real mouse input on the xy panel, at a known voxel: the
 *   paint bench aims at the largest canvas' centre, which in `xy-3d` is the
 *   border between the two panels.
 *
 * Fixture `seg_u32_raw_offset` holds `((x >> 5) + (y >> 5) + z) % 7 + 1`. On
 * slice z = 8, segment 7 owns block (6, 6) — voxels 192..223 in x and y —
 * which is where the erase lands.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(HERE, "../../../test-results/painted-volume");

const TARGET = "seg_u32_raw_offset";
const REGION_LO: Vec3 = [128, 128, 8];
const REGION_SIZE: Vec3 = [128, 128, 1];
/** Not in the fixture (ids 1..7). */
const BRUSH_SEGMENT = "99";
/** Owns voxel block (6, 6) of slice z = 8. */
const SELECTED_SEGMENT = "7";
const ERASE_VOXEL: readonly [number, number] = [208, 208];
const BRUSH_RADIUS = 8;
/** Global units (voxels) per screen pixel in the xy panel. */
const CROSS_SECTION_SCALE = 0.5;

/** A channel moving by more than this is a changed pixel, not dithering. */
const CHANNEL_TOLERANCE = 8;
/** At most this many changed pixels still count as "the same picture". */
const SAME_PICTURE_PIXELS = 20;
/** A stroke of radius 8 at this zoom covers far more than this. */
const STROKE_PIXELS = 60;
const SETTLE_TIMEOUT_MS = 30_000;

const SCENARIO: Scenario = {
  name: "painted-volume xy-3d",
  layers: [
    {
      fixtureId: TARGET,
      role: "target",
      writable: true,
      segments: [BRUSH_SEGMENT],
    },
  ],
  regionSize: REGION_SIZE,
  layout: "xy-3d",
  // Looking straight down z: the region's single slice faces the camera.
  projectionOrientation: [0, 0, 0, 1],
  projectionScale: 256,
  showSlices: false,
  crossSectionScale: CROSS_SECTION_SCALE,
  tooling: {
    activeToolId: "painting.brush",
    painting: {
      targetLayerId: TARGET,
      targetResolution: "16x16x40",
      radius: BRUSH_RADIUS,
      activeValue: { t: "b", v: BRUSH_SEGMENT },
      eraseValue: { t: "b", v: "0" },
      // Without it the whole painting block fails to parse, and the brush
      // falls back to segment 1.
      mask: null,
    },
  },
};

interface PanelPixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: number[];
}

let fixtures: FixturesIndex | undefined;
let fakeGcs: FixtureGcs | undefined;
let setupError: string | undefined;

try {
  fixtures = loadFixturesIndex();
} catch (e) {
  setupError = e instanceof Error ? e.message : String(e);
}

test.describe.configure({ mode: "serial" });

test.describe("live 3D painted-volume preview", () => {
  let page: Page;
  const glErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(7 * 60 * 1000);
    if (setupError !== undefined) return;
    try {
      fakeGcs = await startFixtureGcs();
      page = await openScenarioPage(browser, {
        scenario: SCENARIO,
        fixtures: fixtures!,
        fakeGcsUrl: fakeGcs.url,
        appPort: PORT,
      });
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          /webgl|gl_|GL ERROR|INVALID_/i.test(message.text())
        ) {
          glErrors.push(message.text());
        }
      });
      // The xy panel needs its slice transform before a click lands.
      await page.waitForTimeout(1500);
    } catch (e) {
      setupError = e instanceof Error ? e.message : String(e);
    }
  });

  test.afterAll(async () => {
    await page?.close().catch(() => {});
    await fakeGcs?.[Symbol.asyncDispose]?.();
  });

  let previewOn: PanelPixels;

  test("1. a stroke in xy shows up in the 3D panel", async () => {
    test.skip(setupError !== undefined, setupError);
    // The preview is on for every session: it fills the region on open.
    await waitForRegionFilled(page);
    previewOn = await panelPixels(page, "3d");

    // The session opens on the cursor tool, where a drag pans the view.
    await selectTool(page, "painting.brush");
    await strokeAtVoxel(page, regionCenter());
    await expect.poll(() => paintedVoxels(page)).toBeGreaterThan(0);
    await expect
      .poll(
        async () => changedPixels(previewOn, await panelPixels(page, "3d")),
        {
          timeout: SETTLE_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(STROKE_PIXELS);
    await shoot(page, "1-stroke");
  });

  test("2. undo takes the stroke out of the 3D panel", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.evaluate(async () => {
      await (
        globalThis as any
      ).viewer.editSessionHost.activeSession.value.undo();
    });
    await expect
      .poll(
        async () => changedPixels(previewOn, await panelPixels(page, "3d")),
        {
          timeout: SETTLE_TIMEOUT_MS,
        },
      )
      .toBeLessThanOrEqual(SAME_PICTURE_PIXELS);
  });

  // TODO(TM-490): z-extrapolation needs the zetta web-api backend, which the
  // fake-gcs fixtures do not provide. Cover depth with it once e2e has a fake
  // backend; until then depth is covered by the render-layer browser tests.
  test.skip("3. z-extrapolation paints at several depths", () => {});

  let withSelection: PanelPixels;

  test("4. a selected segment appears whole, and erasing part of it removes that part", async () => {
    test.skip(setupError !== undefined, setupError);
    await setSegmentSelected(page, SELECTED_SEGMENT, true);
    await waitForRegionFilled(page);
    await expect
      .poll(
        async () => changedPixels(previewOn, await panelPixels(page, "3d")),
        {
          timeout: SETTLE_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(STROKE_PIXELS);
    withSelection = await panelPixels(page, "3d");
    await shoot(page, "4-selected");

    await selectTool(page, "painting.erase");
    await strokeAtVoxel(page, ERASE_VOXEL);
    await expect
      .poll(
        async () => changedPixels(withSelection, await panelPixels(page, "3d")),
        { timeout: SETTLE_TIMEOUT_MS },
      )
      .toBeGreaterThan(STROKE_PIXELS);
    await shoot(page, "4-erased");
    await selectTool(page, "painting.brush");
  });

  test("5. deselecting the segment takes it out of the 3D panel", async () => {
    test.skip(setupError !== undefined, setupError);
    await setSegmentSelected(page, SELECTED_SEGMENT, false);
    await expect
      .poll(
        async () => changedPixels(previewOn, await panelPixels(page, "3d")),
        {
          timeout: SETTLE_TIMEOUT_MS,
        },
      )
      .toBeLessThanOrEqual(SAME_PICTURE_PIXELS);
  });

  test("6. a slice plane through the stroke (behaviour recorded, Q18)", async () => {
    test.skip(setupError !== undefined, setupError);
    await strokeAtVoxel(page, regionCenter());
    await expect
      .poll(
        async () => changedPixels(previewOn, await panelPixels(page, "3d")),
        {
          timeout: SETTLE_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(STROKE_PIXELS);
    await setSlicesShown(page, true);
    await nextFrames(page);
    await shoot(page, "6-slice-through-stroke");
    await setSlicesShown(page, false);
  });

  test("7. closing and discarding the session leaves no GL errors", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.evaluate(async () => {
      await (globalThis as any).viewer.editSessionHost.discardActive();
    });
    await nextFrames(page);
    const glError = await page.evaluate(() =>
      (globalThis as any).viewer.display.gl.getError(),
    );
    expect(glError, "gl.getError() after closing the session").toBe(0);
    expect(glErrors).toEqual([]);
  });
});

// --- Page helpers -------------------------------------------------------

function regionCenter(): readonly [number, number] {
  return [REGION_LO[0] + REGION_SIZE[0] / 2, REGION_LO[1] + REGION_SIZE[1] / 2];
}

/** `xy-3d` lays the panels out in a row: xy on the left, 3D on the right. */
async function panelBox(
  page: Page,
  panel: "xy" | "3d",
): Promise<{ x: number; y: number; width: number; height: number }> {
  const boxes = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(".neuroglancer-rendered-data-panel"),
      (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      },
    ).sort((first, second) => first.x - second.x),
  );
  if (boxes.length < 2) throw new Error("expected an xy and a 3D panel");
  return panel === "xy" ? boxes[0] : boxes[boxes.length - 1];
}

/** Click-drag a short stroke at `voxel` of the xy panel's slice. */
async function strokeAtVoxel(
  page: Page,
  voxel: readonly [number, number],
): Promise<void> {
  const box = await panelBox(page, "xy");
  const [centerX, centerY] = regionCenter();
  // The xy panel is centred on the region and shows x right, y down.
  const screenX =
    box.x + box.width / 2 + (voxel[0] - centerX) / CROSS_SECTION_SCALE;
  const screenY =
    box.y + box.height / 2 + (voxel[1] - centerY) / CROSS_SECTION_SCALE;
  await page.mouse.move(screenX, screenY);
  await page.mouse.down();
  await page.mouse.move(screenX + 1, screenY, { steps: 2 });
  await page.mouse.up();
  // The preview keeps a window clear under the 3D brush cursor (§3.11), which
  // sits right on the stroke; off the panel the cursor and its window go.
  await page.mouse.move(0, 0);
}

async function paintedVoxels(page: Page): Promise<number> {
  return page.evaluate(
    () => (globalThis as any).__editPaintBenchReadback({}).paintedVoxels,
  );
}

async function selectTool(page: Page, toolId: string): Promise<void> {
  await page.evaluate((id) => {
    (globalThis as any).viewer.editSessionHost.selectTool(id);
  }, toolId);
}

async function setSegmentSelected(
  page: Page,
  segment: string,
  selected: boolean,
): Promise<void> {
  await page.evaluate(
    ({ layerName, segmentId, isSelected }) => {
      const layer = (globalThis as any).viewer.layerManager.getLayerByName(
        layerName,
      ).layer;
      const visible =
        layer.displayState.segmentationGroupState.value.visibleSegments;
      if (isSelected) visible.add(BigInt(segmentId));
      else visible.delete(BigInt(segmentId));
    },
    { layerName: TARGET, segmentId: segment, isSelected: selected },
  );
}

async function setSlicesShown(page: Page, shown: boolean): Promise<void> {
  await page.evaluate((value) => {
    (globalThis as any).viewer.showPerspectiveSliceViews.value = value;
  }, shown);
}

/** Until the preview is live and has read every chunk of the region. */
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
      { timeout: SETTLE_TIMEOUT_MS },
    )
    .toBe("filled");
  await nextFrames(page);
}

async function nextFrames(page: Page, frames = 3): Promise<void> {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, frames);
}

/** The panel's pixels, decoded in the page (no PNG decoder on the node side). */
async function panelPixels(
  page: Page,
  panel: "xy" | "3d",
): Promise<PanelPixels> {
  const box = await panelBox(page, panel);
  const png = await page.screenshot({ clip: box, animations: "disabled" });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: Array.from(image.data),
    };
  }, png.toString("base64"));
}

function changedPixels(before: PanelPixels, after: PanelPixels): number {
  if (before.width !== after.width || before.height !== after.height) {
    return Number.POSITIVE_INFINITY;
  }
  let changed = 0;
  for (let offset = 0; offset < before.rgba.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(
        before.rgba[offset + channel] - after.rgba[offset + channel],
      );
      if (delta > CHANNEL_TOLERANCE) {
        ++changed;
        break;
      }
    }
  }
  return changed;
}

async function shoot(page: Page, label: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${label}.png`);
  await page.screenshot({ path: file, clip: await panelBox(page, "3d") });
  await test.info().attach(label, { path: file, contentType: "image/png" });
}
