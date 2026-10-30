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
 * Session region load benchmark: how long the background preload takes to
 * load and pin an edit region, and when the view is ready, with every data
 * request delayed like a GCS round trip (the local fixtures answer at once,
 * which hides how the preload scales with the requests it keeps in flight).
 *
 * The view must be ready before the region is: the preload's fetches outrank
 * every other chunk, so a pool holding all of neuroglancer's download slots
 * would leave the view waiting for the whole region.
 *
 * Also checks that a region larger than the viewer's memory budget still loads
 * and leaves the viewer loading: pinned chunks can never be evicted, so a
 * pinned set filling the memory limit used to stop every load for good.
 */

import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  buildNgState,
  type Scenario,
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
const POLL_MS = 100;
/** Chunks in `LOAD_SCENARIO`'s region. */
const LOAD_SCENARIO_CHUNKS = 1344;
/**
 * Upper bound on the region load. At 100 ms per request and a pool of 50, the
 * requests alone take ~2.7 s; locally the load takes 3.5–4.5 s. A slower
 * machine can raise it with `EDITING_PERF_REGION_LOAD_LIMIT_MS`.
 */
const REGION_LOAD_LIMIT_MS = Number(
  process.env.EDITING_PERF_REGION_LOAD_LIMIT_MS ?? 10_000,
);

/** Image + uint64 target at two resolutions over 1024 × 1024 × 64: 1344 chunks. */
const LOAD_SCENARIO: Scenario = {
  name: "load: image + seg target, 2 resolutions",
  layers: [
    { fixtureId: "load_img_u8_raw", role: "image", writable: false },
    { fixtureId: "load_seg_u64_cseg", role: "target", writable: true },
  ],
  crossSectionScale: 2.0,
};

interface LoadSample {
  readonly sessionOpen: boolean;
  readonly viewReady: boolean;
  readonly progress: {
    readonly kind: string;
    readonly total?: number;
    readonly failed?: number;
    readonly failures?: readonly unknown[];
    readonly skipped?: number;
  };
}

/** The parts of the page's `window.viewer` this benchmark reads and moves. */
interface ViewerWindow {
  readonly viewer?: {
    isReady(): boolean;
    readonly navigationState: {
      readonly position: { value: Float32Array };
    };
    readonly editSessionHost?: {
      readonly activeSession?: { readonly value?: unknown };
      readonly chunkLoadProgress?: { readonly value: unknown };
    };
  };
}

interface LoadResult {
  readonly viewReadyMs: number | undefined;
  readonly regionLoadedMs: number | undefined;
  readonly progress: LoadSample["progress"];
}

function sample(page: Page): Promise<LoadSample> {
  return page.evaluate(() => {
    const viewer = (window as unknown as ViewerWindow).viewer;
    const host = viewer?.editSessionHost;
    return {
      sessionOpen: host?.activeSession?.value !== undefined,
      viewReady: viewer?.isReady() ?? false,
      progress: (host?.chunkLoadProgress?.value ?? {
        kind: "none",
      }) as LoadSample["progress"],
    };
  });
}

/**
 * Open the scenario and follow it until the region preload is done and the
 * view ready, or until nothing progresses for `STALL_MS`. Times count from
 * the session opening.
 */
async function openAndLoad(
  page: Page,
  state: Record<string, unknown>,
): Promise<LoadResult> {
  await page.goto(`/#!${encodeURIComponent(JSON.stringify(state))}`, {
    waitUntil: "domcontentloaded",
  });
  let openedAt: number | undefined;
  let viewReadyAt: number | undefined;
  let regionLoadedAt: number | undefined;
  let lastProgress = "";
  let lastChangeAt = Date.now();
  let latest: LoadSample | undefined;
  while (regionLoadedAt === undefined || viewReadyAt === undefined) {
    latest = await sample(page);
    const now = Date.now();
    if (latest.sessionOpen) openedAt ??= now;
    if (openedAt !== undefined && latest.viewReady) viewReadyAt ??= now;
    if (latest.progress.kind === "done") regionLoadedAt ??= now;
    const progress = JSON.stringify(latest.progress);
    if (progress !== lastProgress) {
      lastProgress = progress;
      lastChangeAt = now;
    }
    if (now - lastChangeAt > STALL_MS) break;
    await page.waitForTimeout(POLL_MS);
  }
  const since = (at: number | undefined) =>
    at === undefined || openedAt === undefined ? undefined : at - openedAt;
  return {
    viewReadyMs: since(viewReadyAt),
    regionLoadedMs: since(regionLoadedAt),
    progress: latest!.progress,
  };
}

/**
 * Run `body` on a fresh page whose GCS reads go to the fixtures, delayed like
 * GCS. The page's context closes however `body` ends.
 */
async function withPage(
  browser: Browser,
  fakeGcsUrl: string,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
  });
  try {
    const page = await context.newPage();
    await installGcsRoute(page, fakeGcsUrl, { latencyMs: GCS_LATENCY_MS });
    await body(page);
  } finally {
    await context.close();
  }
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? "never" : `${(ms / 1000).toFixed(2)} s`;
}

test("loads the session region with GCS-like latency, view first", async ({
  browser,
}) => {
  await using gcs = await startFixtureGcs();
  await withPage(browser, gcs.url, async (page) => {
    const result = await openAndLoad(
      page,
      buildNgState(LOAD_SCENARIO, loadFixturesIndex()),
    );
    console.log(
      `[chunk-load] ${result.progress.total} chunks at ${GCS_LATENCY_MS} ms per request: ` +
        `view ready ${seconds(result.viewReadyMs)}, ` +
        `region loaded ${seconds(result.regionLoadedMs)}`,
    );

    expect(
      result.regionLoadedMs,
      `the region load stalled for ${STALL_MS} ms at ${JSON.stringify(result.progress)}`,
    ).toBeDefined();
    expect(
      result.viewReadyMs,
      `the view was not ready ${STALL_MS} ms after the region loaded`,
    ).toBeDefined();
    // Every chunk loaded: none failed, none skipped.
    expect(result.progress).toEqual({
      kind: "done",
      total: LOAD_SCENARIO_CHUNKS,
      failed: 0,
      failures: [],
    });
    expect(result.regionLoadedMs).toBeLessThan(REGION_LOAD_LIMIT_MS);
    // The view does not wait for the region. Strictly earlier: a view that
    // waits for the region is ready in the same poll as the region.
    expect(result.viewReadyMs!).toBeLessThan(result.regionLoadedMs!);
  });
});

test("a region over the memory budget loads, and so does the view outside it", async ({
  browser,
}) => {
  await using gcs = await startFixtureGcs();
  await withPage(browser, gcs.url, async (page) => {
    // Edit the left half only, with a system memory limit the region exceeds.
    const state: Record<string, unknown> = buildNgState(
      { ...LOAD_SCENARIO, regionSize: [512, 1024, 64] },
      loadFixturesIndex(),
    );
    state.systemMemoryLimit = 40_000_000;
    const result = await openAndLoad(page, state);
    console.log(
      `[chunk-load] over budget: region loaded ${seconds(result.regionLoadedMs)}, ` +
        `${result.progress.skipped ?? 0} of ${result.progress.total} chunks not pinned`,
    );
    expect(
      result.progress.kind,
      `the region load stalled for ${STALL_MS} ms at ${JSON.stringify(result.progress)}`,
    ).toBe("done");
    expect(result.progress.skipped).toBeGreaterThan(0);

    // The right half is outside the session: plain viewer loads, which a full
    // pinned set would block.
    await page.evaluate(() => {
      const viewer = (window as unknown as ViewerWindow).viewer!;
      viewer.navigationState.position.value = Float32Array.of(800, 512, 40);
    });
    // Let the panels pick up the move before asking whether they are ready.
    await page.waitForTimeout(3 * POLL_MS);
    await page.waitForFunction(
      () => (window as unknown as ViewerWindow).viewer!.isReady(),
      undefined,
      { timeout: STALL_MS, polling: POLL_MS },
    );
  });
});
