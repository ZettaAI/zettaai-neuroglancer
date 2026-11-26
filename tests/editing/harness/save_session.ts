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
 * Shared driver for the save e2e (`*.save.e2e.ts`, TM-331): fresh storage
 * (fake-gcs + the real web API painting routes), a scenario page whose
 * backend is that web API, deterministic stamps, saves, the storage oracle,
 * and what a page shows (NG's own value lookup).
 */

import path from "node:path";

import { expect, type Browser, type Page } from "@playwright/test";

import {
  installBackendRoute,
  E2E_BACKEND_ORIGIN,
  type BackendRoute,
} from "#tests/editing/harness/backend_route.js";
import type {
  FixtureInfo,
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
import {
  countValue,
  readStoredVolume,
  voxelSetSignature,
  type StoredDataType,
  type StoredVolume,
  type StoredVoxel,
} from "#tests/editing/harness/storage_oracle.js";

import { startPaintingWebApi } from "./webapi_server.mjs";

export { paintedVoxelMap } from "#tests/editing/harness/painted_voxels.js";

export const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);
const RESULTS_DIR = path.resolve("test-results", "save");

/**
 * The brush value. Chosen absent from the fixtures (asserted per run), so every
 * painted voxel changes in storage and the storage diff equals the painted set.
 */
export const PAINT_VALUE = 100;

export interface ReadbackShape {
  error?: string;
  paintedVoxels: number;
  chunkCount: number;
  bbox: { lo: Vec3; hi: Vec3 } | null;
  signature: string;
  distinctValues: string[];
  strokeFired: boolean;
}

export interface SaveOutcome {
  overall: string;
  outcomes: Array<{ layerId: string; status: string; errorCode?: string }>;
  progress: { kind: string; unconfirmed?: number; total?: number };
  unsaved: boolean;
}

export interface WebApi {
  readonly url: string;
  output(): string;
  [Symbol.asyncDispose](): Promise<void>;
}

let fixturesIndex: FixturesIndex | undefined;

/** The generated default fixture set (loaded once). */
export function editingFixtures(): FixturesIndex {
  fixturesIndex ??= loadFixturesIndex();
  return fixturesIndex;
}

export function targetFixture(
  index: FixturesIndex,
  scenario: Scenario,
): FixtureInfo {
  const target = scenario.layers.find((layer) => layer.role === "target")!;
  return index.fixtures.find((fixture) => fixture.id === target.fixtureId)!;
}

/** The edit region [lo, hi) — `buildNgState`'s default: the whole target. */
export function regionOf(fixture: FixtureInfo, scenario: Scenario) {
  const size = scenario.regionSize ?? fixture.size;
  const lo = fixture.offset;
  const hi: Vec3 = [lo[0] + size[0], lo[1] + size[1], lo[2] + size[2]];
  return { lo, hi };
}

/**
 * The storage URL `/cutout` is addressed with: the bare `gs://bucket/layer`,
 * no `precomputed://` (the client's mapping mirrors the portal's, TM-289).
 * Built from the fixtures index, not from the client's own mapping.
 */
export function storagePath(
  index: FixturesIndex,
  fixture: FixtureInfo,
): string {
  return `gs://${index.bucket}/${fixture.id}`;
}

export async function configureE2eBackend(page: Page): Promise<boolean> {
  return page.evaluate((baseUrl) => {
    const host = (window as any).viewer.editSessionHost;
    host.configureBackend({ baseUrl, authorize: (init: unknown) => init });
    return host.backendAvailable.value as boolean;
  }, E2E_BACKEND_ORIGIN);
}

export async function hasUnsavedEdits(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as any).viewer.editSessionHost.hasUnsavedEdits() as boolean,
  );
}

/**
 * One deterministic stamp of `value` at a panel fraction, read back in
 * absolute coordinates. `clearFirst` stays false: the session is clean after
 * the warm-up, and clearing the mirror would hide earlier strokes from the
 * read-back.
 */
export async function stamp(
  page: Page,
  originOffset: Vec3,
  options: {
    value?: number;
    fracX?: number;
    fracY?: number;
    radius?: number;
  } = {},
): Promise<ReadbackShape> {
  return (await page.evaluate(
    async ({ offset, value, fracX, fracY, radius }) => {
      const host = (window as any).viewer.editSessionHost;
      host.painting.state.patchState({ activeValue: value });
      return await (window as any).__editPaintBenchStampReadback({
        radius,
        prime: 0,
        clearFirst: false,
        originOffset: offset,
        fracX,
        fracY,
      });
    },
    {
      offset: originOffset,
      value: options.value ?? PAINT_VALUE,
      fracX: options.fracX ?? 0.5,
      fracY: options.fracY ?? 0.5,
      radius: options.radius ?? 6,
    },
  )) as ReadbackShape;
}

/** What a read-back reports about a target's painted voxels. */
export type PaintedSummary = Pick<
  ReadbackShape,
  "paintedVoxels" | "chunkCount" | "bbox" | "signature" | "distinctValues"
>;

/**
 * One dab of `value` centred on the absolute target voxel `voxel` (x, y on the
 * slice in view), then the read-back of `layerId`'s painted voxels — of every
 * stroke on that layer so far. Voxels are addressed from where the view really
 * is: NG snaps the state's position to a voxel centre.
 */
export async function stampAtVoxel(
  page: Page,
  voxel: readonly [number, number],
  options: {
    layerId: string;
    originOffset: Vec3;
    radius: number;
    value?: number;
  },
): Promise<PaintedSummary> {
  return page.evaluate(
    async ({ voxel, layerId, originOffset, radius, value }) => {
      const viewer = (window as any).viewer;
      const [centreX, centreY] = Array.from(
        viewer.navigationState.position.value as Float32Array,
      );
      viewer.editSessionHost.painting.state.patchState({ activeValue: value });
      await (window as any).__editPaintBenchVoxelStroke({
        path: [[voxel[0] + 0.5 - centreX, voxel[1] + 0.5 - centreY]],
        radius,
      });
      return (window as any).__editPaintBenchReadback({
        originOffset,
        layerId,
      });
    },
    {
      voxel: [...voxel],
      layerId: options.layerId,
      originOffset: [...options.originOffset],
      radius: options.radius,
      value: options.value ?? PAINT_VALUE,
    },
  );
}

/** Pick the brush's target layer in the brush panel, as a user does. */
export async function chooseTargetLayer(
  page: Page,
  layerId: string,
): Promise<void> {
  await page
    .locator(".neuroglancer-tool-panel-row", { hasText: "Target layer" })
    .locator("select")
    .selectOption(layerId);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).viewer.editSessionHost.painting.state.getState()
            .targetLayerId as string,
      ),
    )
    .toBe(layerId);
}

/** Page-side record of one `saveActive` run (see {@link saveActive}). */
type SaveRun =
  | { readonly state: "pending"; readonly promise: Promise<void> }
  | { readonly state: "done"; readonly outcome: SaveOutcome }
  | { readonly state: "failed"; readonly message: string };

/**
 * `host.saveActive()`, as the test's own call, and what it reports.
 *
 * The save is started in the page and its promise is kept reachable on the
 * page (`__e2eSaveRuns`) while the test polls for the result with short
 * evaluates; the entry is deleted once read. Awaiting the save inside a single
 * long `page.evaluate` is not reliable: the DevTools protocol can drop that
 * await ("Promise was collected", which Playwright reports as "Execution
 * context was destroyed … navigation") even though the save completes in the
 * page — seen under GC pressure with two writable + two locked layers. The
 * outcome is read the same way as before, right after the save settles.
 */
export async function saveActive(page: Page): Promise<SaveOutcome> {
  const runId = await page.evaluate(() => {
    const w = window as any;
    const runs: Map<number, SaveRun> = (w.__e2eSaveRuns ??= new Map());
    const id: number = (w.__e2eSaveRunSeq = (w.__e2eSaveRunSeq ?? 0) + 1);
    const host = w.viewer.editSessionHost;
    const promise = (host.saveActive() as Promise<any>).then(
      (result) => {
        runs.set(id, {
          state: "done",
          outcome: {
            overall: result.overall,
            outcomes: result.outcomes.map((outcome: any) => ({
              layerId: String(outcome.layerId),
              status: outcome.status,
              errorCode: outcome.error?.code,
            })),
            progress: { ...host.saveProgress.value },
            unsaved: host.hasUnsavedEdits(),
          },
        });
      },
      (error) => {
        runs.set(id, {
          state: "failed",
          message: String(error?.stack ?? error),
        });
      },
    );
    runs.set(id, { state: "pending", promise });
    return id;
  });
  let settled: SaveRun | undefined;
  await expect
    .poll(
      async () => {
        settled = await page.evaluate((id) => {
          const runs: Map<number, SaveRun> = (window as any).__e2eSaveRuns;
          const run = runs.get(id);
          if (run === undefined || run.state === "pending") return undefined;
          runs.delete(id);
          return run;
        }, runId);
        return settled !== undefined;
      },
      { message: "save did not settle", timeout: 120_000, intervals: [50] },
    )
    .toBe(true);
  if (settled!.state === "failed") {
    throw new Error(`host.saveActive() rejected: ${settled!.message}`);
  }
  return (settled as { state: "done"; outcome: SaveOutcome }).outcome;
}

/** The bbox a `/painting/cutout` request wrote, from its repeated-key query. */
export function postedBox(query: URLSearchParams): { lo: Vec3; hi: Vec3 } {
  const start = query.getAll("bbox_start").map(Number);
  const end = query.getAll("bbox_end").map(Number);
  return {
    lo: [start[0], start[1], start[2]],
    hi: [end[0], end[1], end[2]],
  };
}

export function boxWithin(
  box: { lo: Vec3; hi: Vec3 },
  region: { lo: Vec3; hi: Vec3 },
): boolean {
  return [0, 1, 2].every(
    (axis) =>
      box.lo[axis] >= region.lo[axis] && box.hi[axis] <= region.hi[axis],
  );
}

/** Fresh fake-gcs + web API over it. A save mutates storage. */
export async function startStorage(label: string): Promise<{
  fakeGcs: FixtureGcs;
  webApi: WebApi;
  dispose(): Promise<void>;
}> {
  const fakeGcs = await startFixtureGcs();
  const webApi = (await startPaintingWebApi({
    fakeGcsUrl: fakeGcs.url,
    logPath: path.join(RESULTS_DIR, `${label.replace(/\W+/g, "_")}.webapi.log`),
  })) as WebApi;
  return {
    fakeGcs,
    webApi,
    async dispose() {
      await webApi[Symbol.asyncDispose]();
      await fakeGcs[Symbol.asyncDispose]();
    },
  };
}

/**
 * A scenario page whose backend is the local web API (configured the way the
 * portal does it), warmed up, with nothing to save yet.
 */
export async function openEditingPage(
  browser: Browser,
  scenario: Scenario,
  storage: { fakeGcs: FixtureGcs; webApi: WebApi },
): Promise<{ page: Page; backend: BackendRoute }> {
  const page = await openScenarioPage(browser, {
    scenario,
    fixtures: editingFixtures(),
    fakeGcsUrl: storage.fakeGcs.url,
    appPort: PORT,
  });
  const backend = await installBackendRoute(page, storage.webApi.url);
  expect(await configureE2eBackend(page), "backend not available").toBe(true);
  await warmupPaintPath(page, { label: scenario.name });
  expect(await hasUnsavedEdits(page)).toBe(false);
  return { page, backend };
}

export function readTargetRegion(
  webApi: WebApi,
  fixture: FixtureInfo,
  region: { lo: Vec3; hi: Vec3 },
): Promise<StoredVolume> {
  return readStoredVolume(webApi.url, {
    layerPath: storagePath(editingFixtures(), fixture),
    dataType: fixture.dtype as StoredDataType,
    start: region.lo,
    end: region.hi,
    resolution: fixture.resolutions[0],
  });
}

/** One deterministic stamp of {@link PAINT_VALUE}, checked before anything relies on it. */
export async function paintOneStamp(
  page: Page,
  fixture: FixtureInfo,
  region: { lo: Vec3; hi: Vec3 },
  before: StoredVolume,
): Promise<ReadbackShape> {
  const painted = await stamp(page, fixture.offset);
  expect(painted.error).toBeUndefined();
  expect(painted.strokeFired).toBe(true);
  expect(painted.paintedVoxels).toBeGreaterThan(0);
  expect(painted.bbox).not.toBeNull();
  expect(boxWithin(painted.bbox!, region), "paint outside the region").toBe(
    true,
  );
  const paintValue = String(PAINT_VALUE);
  expect(painted.distinctValues).toEqual([paintValue]);
  // Every painted voxel must CHANGE in storage for the diff to equal the
  // painted set; a value already in the fixture would hide some of them.
  expect(
    countValue(before, paintValue),
    `paint value ${paintValue} already in the fixture`,
  ).toBe(0);
  expect(await hasUnsavedEdits(page)).toBe(true);
  return painted;
}

export function cutoutWrites(backend: BackendRoute) {
  return backend.requests.filter(
    (request) =>
      request.method === "POST" && request.pathname === "/painting/cutout",
  );
}

/** Storage changed in exactly the painted voxels, to the painted value. */
export function expectStorageHoldsExactly(
  changed: readonly StoredVoxel[],
  painted: Pick<ReadbackShape, "paintedVoxels" | "signature">,
  value: number = PAINT_VALUE,
): void {
  expect(changed.length).toBe(painted.paintedVoxels);
  expect(new Set(changed.map((voxel) => voxel.value))).toEqual(
    new Set([String(value)]),
  );
  expect(voxelSetSignature(changed)).toBe(painted.signature);
}

/** `box` grown by `margin` voxels in x and y, clipped to `region`. */
export function grownInPlane(
  box: { lo: Vec3; hi: Vec3 },
  margin: number,
  region: { lo: Vec3; hi: Vec3 },
): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [
    Math.max(region.lo[0], box.lo[0] - margin),
    Math.max(region.lo[1], box.lo[1] - margin),
    box.lo[2],
  ];
  const hi: Vec3 = [
    Math.min(region.hi[0], box.hi[0] + margin),
    Math.min(region.hi[1], box.hi[1] + margin),
    box.hi[2],
  ];
  return { lo, hi };
}

export function voxelsOf(box: { lo: Vec3; hi: Vec3 }): Vec3[] {
  const voxels: Vec3[] = [];
  for (let z = box.lo[2]; z < box.hi[2]; z++) {
    for (let y = box.lo[1]; y < box.hi[1]; y++) {
      for (let x = box.lo[0]; x < box.hi[0]; x++) voxels.push([x, y, z]);
    }
  }
  return voxels;
}

/** The value storage holds at an absolute voxel. */
export function storedValueAt(volume: StoredVolume, [x, y, z]: Vec3): string {
  const sizeX = volume.end[0] - volume.start[0];
  const sizeY = volume.end[1] - volume.start[1];
  const linearIndex =
    x -
    volume.start[0] +
    sizeX * (y - volume.start[1] + sizeY * (z - volume.start[2]));
  return volume.values[linearIndex];
}

/**
 * What the app shows at each voxel: NG's own value lookup on the layer's
 * volume render layers (the hover/pick path), over the chunks it loaded from
 * storage. Global coordinates are the target's voxels (`buildNgState`), so a
 * voxel's centre is `voxel + 0.5`. Waits until every voxel has a loaded chunk.
 */
export async function appValuesAt(
  page: Page,
  layerName: string,
  voxels: readonly Vec3[],
): Promise<string[]> {
  return page.evaluate(
    async ({ name, points }) => {
      const userLayer = (window as any).viewer.layerManager.getLayerByName(
        name,
      ).layer;
      const volumeLayers = userLayer.renderLayers.filter(
        (layer: any) => layer.multiscaleSource !== undefined,
      );
      const read = () =>
        points.map(([x, y, z]) => {
          const position = new Float32Array([x + 0.5, y + 0.5, z + 0.5]);
          for (const layer of volumeLayers) {
            const value = layer.getValueAt(position);
            if (value != null) return String(value);
          }
          return null;
        });
      const started = performance.now();
      let values = read();
      while (
        values.some((value) => value === null) &&
        performance.now() - started < 60_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        values = read();
      }
      return values.map((value) => value ?? "not loaded");
    },
    { name: layerName, points: voxels.map((voxel) => [...voxel]) },
  );
}

/** What the session UI shows: unsaved flag, save progress, open dialogs. */
export interface SessionUiState {
  readonly sessionActive: boolean;
  readonly unsaved: boolean;
  readonly saveProgress: string;
  readonly dialogs: ReadonlyArray<{ title: string; buttons: string[] }>;
}

export async function sessionUiState(page: Page): Promise<SessionUiState> {
  return page.evaluate(() => {
    const host = (window as any).viewer.editSessionHost;
    return {
      sessionActive: host.activeSession.value !== undefined,
      unsaved: host.hasUnsavedEdits() as boolean,
      saveProgress: host.saveProgress.value.kind as string,
      dialogs: [
        ...document.querySelectorAll(".neuroglancer-confirm-dialog"),
      ].map((dialog) => ({
        title:
          dialog
            .querySelector(".neuroglancer-confirm-dialog-title")
            ?.textContent?.trim() ??
          (dialog as HTMLElement).innerText.split("\n")[0].trim(),
        buttons: [...dialog.querySelectorAll("button")].map(
          (button) => button.textContent?.trim() ?? "",
        ),
      })),
    };
  });
}

/** Wait until no save is running and progress is back to idle. */
export async function waitForSaveToSettle(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        (await page
          .locator(".neuroglancer-editing-topbar-save-button.saving")
          .count()) === 0 &&
        (await page.evaluate(
          () =>
            (window as any).viewer.editSessionHost.saveInProgress
              .value as boolean,
        )) === false,
      { timeout: 120_000 },
    )
    .toBe(true);
}

/** Press the topbar "Save all" button, as a tracer does. */
export async function clickSaveAll(page: Page): Promise<void> {
  await page.locator(".neuroglancer-editing-topbar-save-button").click();
}

/** Press the topbar "Exit session" button. */
export async function clickExitSession(page: Page): Promise<void> {
  await page.locator(".neuroglancer-editing-topbar-edit-button").click();
}

/** Press a button in the open confirm dialog by its label. */
export async function answerDialog(page: Page, label: string): Promise<void> {
  await page
    .locator(".neuroglancer-confirm-dialog button", { hasText: label })
    .click();
}

/** Wait until the page has (or has no) active session. */
export async function waitForSessionActive(
  page: Page,
  active: boolean,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).viewer.editSessionHost.activeSession.value !==
            undefined,
        ),
      { timeout: 120_000 },
    )
    .toBe(active);
}

/**
 * Wait until a save the user started has fully finished and left nothing
 * unsaved. Stronger than {@link waitForSaveToSettle}: a conflict answer may do
 * work BEFORE its save starts (Take mine snapshots a local draft first), so
 * "no save running" can hold before that save has even begun.
 */
export async function waitForEverythingSaved(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const host = (window as any).viewer.editSessionHost;
          return (
            host.saveInProgress.value === false &&
            host.hasUnsavedEdits() === false
          );
        }),
      { timeout: 120_000 },
    )
    .toBe(true);
}

/**
 * Wait until the open confirm dialog holds keyboard focus. The dialog handles
 * Escape on its own element and focuses itself in an effect after it renders,
 * so a key pressed the moment it appears in the DOM can miss it.
 */
export async function waitForDialogFocus(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.closest(".neuroglancer-confirm-dialog") !=
          null,
      ),
    )
    .toBe(true);
}
