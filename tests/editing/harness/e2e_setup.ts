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
 * Shared setup for the reproducible edit-session e2e specs (TM-331) — the
 * correctness suite AND the paint benchmark both load a `buildNgState` scenario
 * against the local fake-gcs fixtures (no live `gs://`, no auth). This module is
 * the single boot path so the two specs don't drift:
 *
 *   fixtures.json → fake-gcs → GCS route-rewrite → buildNgState → load →
 *   wait for the auto-opened session + harness → (optional) warm the paint path.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "@playwright/test";

import {
  buildNgState,
  type FixtureInfo,
  type FixturesIndex,
  type Scenario,
} from "./build_ng_state.js";
import { startFakeGcsFixtures } from "./fake_gcs_fixtures.mjs";
import { installGcsRoute } from "./gcs_route.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../../testdata/editing");

export interface FixtureGcs {
  readonly url: string;
  [Symbol.asyncDispose](): Promise<void>;
}

/** The generated fixture sets: the default matrix, and the TM-373 4096² set. */
const FIXTURE_SETS = {
  default: { index: "fixtures.json", generateFlags: "" },
  largeChunk: {
    index: "fixtures_large_chunk.json",
    generateFlags: " --large-chunk",
  },
} as const;

export type FixtureSet = keyof typeof FIXTURE_SETS;

/** Load a generated fixtures index, or throw with a run-the-generator hint. */
export function loadFixturesIndex(set: FixtureSet = "default"): FixturesIndex {
  const { index, generateFlags } = FIXTURE_SETS[set];
  const indexPath = path.join(FIXTURES_DIR, index);
  try {
    return JSON.parse(readFileSync(indexPath, "utf8")) as FixturesIndex;
  } catch {
    throw new Error(
      `no fixtures index at ${indexPath} — run: uv run testdata/editing/generate.py${generateFlags}`,
    );
  }
}

/**
 * Boot a fake-gcs server over the generated fixture buckets. Uses a FREE
 * OS-assigned port by default so a leaked server from a prior run never blocks a
 * fresh one; pass `port` only for manual debugging.
 */
export function startFixtureGcs(port?: number): Promise<FixtureGcs> {
  return startFakeGcsFixtures(
    port !== undefined ? { port } : {},
  ) as Promise<FixtureGcs>;
}

/**
 * Open a scenario page: fresh context → GCS route-rewrite → `buildNgState` →
 * load → wait for the auto-opened session + the `__editPaintBench*` harness.
 * Does NOT warm — callers pick their warmup (correctness stamps vs the bench's
 * `__editPaintBenchWarmup`).
 */
export async function openScenarioPage(
  browser: Browser,
  opts: {
    scenario: Scenario;
    fixtures: FixturesIndex;
    fakeGcsUrl: string;
    appPort: number;
    /** Forwarded to `buildNgState`: a layer source other than `gs://`. */
    sourceFor?: (fixture: FixtureInfo) => string;
  },
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: `http://localhost:${opts.appPort}`,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (/error|warn|editPaintBench/i.test(m.text())) {
      console.log(`[page] ${m.text()}`);
    }
  });
  page.on("crash", () => {
    console.log("[page] renderer crashed");
  });
  await installGcsRoute(page, opts.fakeGcsUrl);
  const state = buildNgState(opts.scenario, opts.fixtures, {
    sourceFor: opts.sourceFor,
  });
  await page.goto(`/#!${encodeURIComponent(JSON.stringify(state))}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        viewer?: { editSessionHost?: { activeSession?: { value?: unknown } } };
        __editPaintBenchStampReadback?: unknown;
      };
      return (
        typeof w.__editPaintBenchStampReadback === "function" &&
        w.viewer?.editSessionHost?.activeSession?.value !== undefined
      );
    },
    undefined,
    { timeout: 5 * 60 * 1000 },
  );
  return page;
}

interface SessionPaintState {
  readonly canUndo: boolean;
  readonly unsaved: boolean;
  readonly paintedVoxels: number;
}

async function sessionPaintState(page: Page): Promise<SessionPaintState> {
  return page.evaluate(() => {
    const win = window as unknown as {
      viewer: { editSessionHost: any };
      __editPaintBenchReadback: () => { paintedVoxels: number };
    };
    const host = win.viewer.editSessionHost;
    return {
      canUndo: host.activeSession.value.getHistory().canUndo as boolean,
      unsaved: host.hasUnsavedEdits() as boolean,
      paintedVoxels: win.__editPaintBenchReadback().paintedVoxels,
    };
  });
}

/**
 * Warm the paint path with a few read-back stamps, then undo them: the first
 * stamps on a cold page often don't register (slice transform not laid out,
 * params not propagated). Bounded — each gives up fast if nothing paints.
 *
 * The warm-up leaves NOTHING behind. Its strokes are undone through the
 * session, so the session, the unsaved flag and the render mirror are all back
 * to the freshly opened state. The segments its strokes added to a layer's
 * selection ("Auto-select segment") are removed again too: undo does not touch
 * the selection, and z-extrapolation tracks the selected segments. (It used to only empty the render mirror, which
 * hid real warm-up paint that a later save, undo or count still saw.) Needs a
 * session with an empty history — a fresh page — so the undo can only reach
 * the warm-up's own strokes; it throws otherwise, and if anything is left.
 */
export async function warmupPaintPath(
  page: Page,
  opts: { label: string; stamps?: number } = { label: "scenario" },
): Promise<void> {
  const stamps = opts.stamps ?? 4;
  const before = await sessionPaintState(page);
  if (before.canUndo || before.unsaved) {
    throw new Error(
      `warmupPaintPath(${opts.label}) needs a fresh session: it undoes its ` +
        `own strokes and must not reach earlier ones ` +
        `(canUndo=${before.canUndo}, unsaved=${before.unsaved})`,
    );
  }
  const selectionBefore = await segmentSelections(page);
  await page.waitForTimeout(1000);
  for (let i = 0; i < stamps; i++) {
    const w = (await page.evaluate(async () => {
      const win = window as unknown as {
        __editPaintBenchStampReadback: (
          i: unknown,
        ) => Promise<{ paintedVoxels: number }>;
      };
      return win.__editPaintBenchStampReadback({
        radius: 8,
        prime: 0,
        clearFirst: true,
      });
    })) as { paintedVoxels: number };
    console.log(
      `[warmup] ${opts.label} stamp ${i + 1}/${stamps}: painted=${w.paintedVoxels}`,
    );
    if (w.paintedVoxels > 0 && i >= 1) break; // warm once it reliably paints
  }
  await page.evaluate(async () => {
    const session = (window as unknown as { viewer: { editSessionHost: any } })
      .viewer.editSessionHost.activeSession.value;
    while (session.getHistory().canUndo) await session.undo();
  });
  // The mirror settles after the undo resolves; wait for it rather than
  // reading once.
  const deadline = Date.now() + 10_000;
  let after = await sessionPaintState(page);
  while (after.paintedVoxels !== 0 && Date.now() < deadline) {
    await page.waitForTimeout(80);
    after = await sessionPaintState(page);
  }
  if (after.canUndo || after.unsaved || after.paintedVoxels !== 0) {
    throw new Error(
      `warmupPaintPath(${opts.label}) left paint behind: ` +
        `canUndo=${after.canUndo}, unsaved=${after.unsaved}, ` +
        `painted=${after.paintedVoxels}`,
    );
  }
  await deselectSegmentsAddedSince(page, selectionBefore);
  const selectionAfter = await segmentSelections(page);
  if (JSON.stringify(selectionAfter) !== JSON.stringify(selectionBefore)) {
    throw new Error(
      `warmupPaintPath(${opts.label}) left the segment selection changed: ` +
        `${JSON.stringify(selectionBefore)} → ${JSON.stringify(selectionAfter)}`,
    );
  }
}

/** Selected segment IDs per segmentation layer name, sorted. */
type SegmentSelections = Record<string, string[]>;

function segmentSelections(page: Page): Promise<SegmentSelections> {
  return page.evaluate(() => {
    const selections: Record<string, string[]> = {};
    const managedLayers = (window as any).viewer.layerManager
      .managedLayers as any[];
    for (const managed of managedLayers) {
      const group = managed.layer?.displayState?.segmentationGroupState?.value;
      if (group === undefined) continue;
      selections[managed.name] = Array.from(
        group.selectedSegments as Iterable<bigint>,
        String,
      ).sort();
    }
    return selections;
  });
}

async function deselectSegmentsAddedSince(
  page: Page,
  before: SegmentSelections,
): Promise<void> {
  await page.evaluate((selectedBefore) => {
    const managedLayers = (window as any).viewer.layerManager
      .managedLayers as any[];
    for (const managed of managedLayers) {
      const group = managed.layer?.displayState?.segmentationGroupState?.value;
      if (group === undefined) continue;
      const kept = new Set(selectedBefore[managed.name] ?? []);
      for (const id of Array.from(group.selectedSegments as Iterable<bigint>)) {
        if (!kept.has(String(id))) group.selectedSegments.delete(id);
      }
    }
  }, before);
}
