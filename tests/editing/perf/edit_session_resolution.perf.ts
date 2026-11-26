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
 * Session resolution benchmark (TM-524): what a segmentation target with two
 * resolutions (16 and 32 nm) costs to show during an edit session whose
 * session resolution is one of them, at several zoom levels.
 *
 * For each case it counts the target's chunk requests per resolution and
 * their bytes, and times the view and the region preload, with every request
 * delayed like a GCS round trip. Showing only the session's resolution must
 * not make the view slower or load much more than before; the measured
 * numbers are printed and written to `test-results/` for comparison.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  buildNgState,
  type Scenario,
  type Vec3,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  startFixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";
import { installGcsRoute } from "#tests/editing/harness/gcs_route.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);
/** Per-request delay standing in for GCS's time to first byte. */
const GCS_LATENCY_MS = 100;
/** Nothing progressing for this long counts as a hang. */
const STALL_MS = 30_000;
const POLL_MS = 25;
/** Runs per case; times are the median. */
const RUNS = 3;
/** Quiet time after the view is ready before the requests are counted. */
const SETTLE_MS = 1000;

const TARGET = "load_seg_u64_cseg";
const FINE: Vec3 = [16, 16, 40];
const COARSE: Vec3 = [32, 32, 40];
/** NG `crossSectionScale`: 1 = zoomed in on the region, 16 = far out. */
const ZOOMS = [1, 4, 16, 64] as const;

/**
 * Upper bounds per case, from the baseline on main (see the PR) plus room for
 * machine noise. `undefined` = no bound yet (measurement only).
 */
const VIEW_READY_LIMIT_MS = Number(
  process.env.EDITING_PERF_SESSION_RES_VIEW_LIMIT_MS ?? 15_000,
);

function scenario(sessionResolution: Vec3, zoom: number): Scenario {
  return {
    name: `seg target, session ${sessionResolution.join("x")}, zoom ${zoom}`,
    layers: [
      {
        fixtureId: TARGET,
        role: "target",
        writable: true,
        sessionResolutions: [sessionResolution],
      },
    ],
    // A small region, so the counts are mostly what the view loads.
    regionSize: [256, 256, 16],
    crossSectionScale: zoom,
  };
}

interface Sample {
  readonly sessionOpen: boolean;
  readonly viewReady: boolean;
  readonly progressKind: string;
}

interface ViewerWindow {
  readonly viewer?: {
    isReady(): boolean;
    readonly editSessionHost?: {
      readonly activeSession?: { readonly value?: unknown };
      readonly chunkLoadProgress?: { readonly value?: { kind: string } };
    };
  };
}

function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const viewer = (window as unknown as ViewerWindow).viewer;
    const host = viewer?.editSessionHost;
    return {
      sessionOpen: host?.activeSession?.value !== undefined,
      viewReady: viewer?.isReady() ?? false,
      progressKind: host?.chunkLoadProgress?.value?.kind ?? "none",
    };
  });
}

interface RequestCounts {
  /** Target chunk requests per resolution key, e.g. `16_16_40`. */
  readonly requests: Record<string, number>;
  readonly bytes: Record<string, number>;
}

/** Counts the target's chunk reads per resolution as they finish. */
function countTargetChunks(page: Page): RequestCounts {
  const counts = { requests: {}, bytes: {} } as {
    requests: Record<string, number>;
    bytes: Record<string, number>;
  };
  page.on("requestfinished", async (request) => {
    const url = decodeURIComponent(request.url());
    const match = url.match(new RegExp(`/${TARGET}/(\\d+_\\d+_\\d+)/`));
    if (match === null || !url.includes("alt=media")) return;
    const key = match[1];
    counts.requests[key] = (counts.requests[key] ?? 0) + 1;
    const sizes = await request.sizes().catch(() => undefined);
    counts.bytes[key] =
      (counts.bytes[key] ?? 0) + (sizes?.responseBodySize ?? 0);
  });
  return counts;
}

interface CaseResult {
  readonly session: string;
  readonly zoom: number;
  readonly viewReadyMs: number | undefined;
  readonly regionLoadedMs: number | undefined;
  readonly requests: Record<string, number>;
  readonly kilobytes: Record<string, number>;
}

async function measure(
  browser: Browser,
  fakeGcsUrl: string,
  sessionResolution: Vec3,
  zoom: number,
): Promise<CaseResult> {
  const context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
  });
  try {
    const page = await context.newPage();
    await installGcsRoute(page, fakeGcsUrl, { latencyMs: GCS_LATENCY_MS });
    const counts = countTargetChunks(page);
    const state = buildNgState(
      scenario(sessionResolution, zoom),
      loadFixturesIndex(),
    );
    // Times count from opening the page: the view of a session layer is
    // only final once the session is open and its resolutions apply.
    const startedAt = Date.now();
    await page.goto(`/#!${encodeURIComponent(JSON.stringify(state))}`, {
      waitUntil: "domcontentloaded",
    });
    let viewReadyAt: number | undefined;
    let regionLoadedAt: number | undefined;
    while (viewReadyAt === undefined || regionLoadedAt === undefined) {
      const latest = await sample(page);
      const now = Date.now();
      if (latest.sessionOpen && latest.viewReady) viewReadyAt ??= now;
      if (latest.progressKind === "done") regionLoadedAt ??= now;
      if (now - startedAt > STALL_MS) break;
      await page.waitForTimeout(POLL_MS);
    }
    await page.waitForTimeout(SETTLE_MS);
    const since = (at: number | undefined) =>
      at === undefined ? undefined : at - startedAt;
    const kilobytes = Object.fromEntries(
      Object.entries(counts.bytes).map(([key, bytes]) => [
        key,
        Math.round(bytes / 1024),
      ]),
    );
    return {
      session: sessionResolution.join("x"),
      zoom,
      viewReadyMs: since(viewReadyAt),
      regionLoadedMs: since(regionLoadedAt),
      requests: { ...counts.requests },
      kilobytes,
    };
  } finally {
    await context.close();
  }
}

function median(values: (number | undefined)[]): number | undefined {
  if (values.some((value) => value === undefined)) return undefined;
  const sorted = (values as number[]).toSorted(
    (first, second) => first - second,
  );
  return sorted[Math.floor(sorted.length / 2)];
}

/** Median times; request counts and bytes of the first run (fresh cache each run). */
function medianOf(runs: CaseResult[]): CaseResult {
  return {
    ...runs[0],
    viewReadyMs: median(runs.map((run) => run.viewReadyMs)),
    regionLoadedMs: median(runs.map((run) => run.regionLoadedMs)),
  };
}

test("session resolution: chunk requests and view time per zoom", async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000);
  await using gcs = await startFixtureGcs();
  const results: CaseResult[] = [];
  for (const sessionResolution of [FINE, COARSE]) {
    for (const zoom of ZOOMS) {
      const runs: CaseResult[] = [];
      for (let run = 0; run < RUNS; ++run) {
        runs.push(await measure(browser, gcs.url, sessionResolution, zoom));
      }
      results.push(medianOf(runs));
    }
  }
  for (const result of results) {
    console.log(
      `[session-res] session ${result.session} zoom ${result.zoom}: ` +
        `view ${result.viewReadyMs} ms, region ${result.regionLoadedMs} ms, ` +
        `requests ${JSON.stringify(result.requests)}, KiB ${JSON.stringify(result.kilobytes)}`,
    );
  }
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/edit_session_resolution.json",
    JSON.stringify(results, null, 2),
  );
  for (const result of results) {
    expect(
      result.viewReadyMs,
      `${result.session} zoom ${result.zoom}: view never ready`,
    ).toBeDefined();
    expect(
      result.regionLoadedMs,
      `${result.session} zoom ${result.zoom}: region never loaded`,
    ).toBeDefined();
    expect(result.viewReadyMs!).toBeLessThan(VIEW_READY_LIMIT_MS);
  }
});

/** Two resolutions in chunks of 2048²: a full-chunk rebuild is large. */
const FRAME_TARGET = "perf_seg_u64_multires";

interface FrameCase {
  readonly name: string;
  readonly sessionResolution: Vec3;
  readonly crossSectionScale: number;
}

const FRAME_CASES: FrameCase[] = [
  {
    name: "session 16 nm, zoomed out (32 nm drawn)",
    sessionResolution: FINE,
    crossSectionScale: 6,
  },
  {
    name: "session 32 nm, 16 nm drawn",
    sessionResolution: COARSE,
    crossSectionScale: 1.5,
  },
];

interface FrameResult {
  readonly name: string;
  /** Longest gap between animation frames during a big stroke and its undo. */
  readonly longestFrameMs: number;
  /** Sum of long tasks (> 50 ms) in the same time. */
  readonly longTasksMs: number;
}

async function measureFrames(
  browser: Browser,
  fakeGcsUrl: string,
  frameCase: FrameCase,
): Promise<FrameResult> {
  const context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
  });
  try {
    const page = await context.newPage();
    await installGcsRoute(page, fakeGcsUrl);
    const state = buildNgState(
      {
        name: frameCase.name,
        layers: [
          {
            fixtureId: FRAME_TARGET,
            role: "target",
            writable: true,
            sessionResolutions: [frameCase.sessionResolution],
          },
        ],
        crossSectionScale: frameCase.crossSectionScale,
      },
      loadFixturesIndex(),
    );
    await page.goto(`/#!${encodeURIComponent(JSON.stringify(state))}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => {
        const viewer = (window as any).viewer;
        return (
          viewer?.editSessionHost?.activeSession?.value !== undefined &&
          viewer.isReady()
        );
      },
      undefined,
      { timeout: STALL_MS },
    );
    // Warm the paint path, then start from nothing painted.
    await page.evaluate(async () => {
      const bench = window as any;
      await bench.__editPaintBenchStampReadback({ radius: 4, prime: 0 });
      await bench.__editPaintBenchUndoAll();
    });
    await page.waitForTimeout(500);
    return (await page.evaluate(async (name) => {
      const bench = window as any;
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      let longestFrameMs = 0;
      let previous = performance.now();
      let watching = true;
      const watch = (now: number) => {
        longestFrameMs = Math.max(longestFrameMs, now - previous);
        previous = now;
        if (watching) requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
      await bench.__editPaintBenchStampReadback({
        radius: 300,
        prime: 0,
        clearFirst: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await bench.__editPaintBenchUndoAll();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      watching = false;
      observer.disconnect();
      return {
        name,
        longestFrameMs: Math.round(longestFrameMs),
        longTasksMs: Math.round(longTasks.reduce((sum, ms) => sum + ms, 0)),
      };
    }, frameCase.name)) as FrameResult;
  } finally {
    await context.close();
  }
}

test("session resolution: longest frame while a big stroke and its undo show on another level", async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000);
  await using gcs = await startFixtureGcs();
  const results: FrameResult[] = [];
  for (const frameCase of FRAME_CASES) {
    const runs: FrameResult[] = [];
    for (let run = 0; run < RUNS; ++run) {
      runs.push(await measureFrames(browser, gcs.url, frameCase));
    }
    const sorted = (pick: (result: FrameResult) => number) =>
      runs.map(pick).toSorted((first, second) => first - second)[
        Math.floor(runs.length / 2)
      ];
    results.push({
      name: frameCase.name,
      longestFrameMs: sorted((result) => result.longestFrameMs),
      longTasksMs: sorted((result) => result.longTasksMs),
    });
  }
  for (const result of results) {
    console.log(
      `[session-res-frames] ${result.name}: longest frame ${result.longestFrameMs} ms, ` +
        `long tasks ${result.longTasksMs} ms`,
    );
  }
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/edit_session_resolution_frames.json",
    JSON.stringify(results, null, 2),
  );
});
