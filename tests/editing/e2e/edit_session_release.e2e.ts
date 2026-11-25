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
 * A committed session is released (TM-373).
 *
 * Commit → re-open keeps the host and its per-layer patch stores, but the
 * session it committed must go: its overlay holds a working copy, a content
 * ref, a baseline ref and a baseline clone of every touched chunk, and its
 * journal a before-image per entry — 1.5 GB on four 4096² chunks.
 *
 * Measured with a heap snapshot: the objects shaped like an edit session
 * (`overlay` + `historyJournal`) still reachable after the re-open. Whoever
 * holds the old one, it is one too many. Two holders were found: a host
 * display-dimension handler, and content refs that outlive their session
 * (committed and unconfirmed-save chunks) whose closures, once the bundler
 * inlined their builder into `openSession`, kept that call's scope.
 */

import { test, expect, type Page } from "@playwright/test";

import type {
  FixturesIndex,
  Scenario,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  openScenarioPage,
  startFixtureGcs,
  warmupPaintPath,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";
import {
  measureHeapBuffers,
  type BufferOwnerRule,
} from "#tests/editing/harness/heap_buffer_owners.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);

const SCENARIO: Scenario = {
  name: "session-release",
  layers: [
    { fixtureId: "img_u8_raw", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};

const SESSION_RULES: readonly BufferOwnerRule[] = [
  { label: "active", match: ["editSessionHost", "activeSession", "overlay"] },
  {
    label: "active",
    match: ["editSessionHost", "activeSession", "historyJournal"],
  },
];
/** An edit session is the object with both of these. */
const SESSION_EDGES = ["overlay", "historyJournal"];

let fakeGcs: FixtureGcs | undefined;
let fixtures: FixturesIndex | undefined;
let setupError: string | undefined;

test.beforeAll(async () => {
  try {
    fixtures = loadFixturesIndex();
    fakeGcs = await startFixtureGcs();
  } catch (e) {
    setupError = e instanceof Error ? e.message : String(e);
  }
});

test.afterAll(async () => {
  await fakeGcs?.[Symbol.asyncDispose]?.();
});

/**
 * Live edit sessions (by shape, whoever holds them) and the buffer bytes the
 * active one holds. Every buffer size counts: the e2e chunks are small.
 */
async function sessions(
  page: Page,
): Promise<{ live: number; activeBytes: number }> {
  const { census } = await measureHeapBuffers(page, SESSION_RULES, {
    minBytes: 1,
    objectEdges: SESSION_EDGES,
  });
  return {
    live: census.objectsWithEdges,
    activeBytes: census.owners.active?.bytes ?? 0,
  };
}

test.describe("a committed session is released", () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    if (setupError !== undefined) return;
    page = await openScenarioPage(browser, {
      scenario: SCENARIO,
      fixtures: fixtures!,
      fakeGcsUrl: fakeGcs!.url,
      appPort: PORT,
    });
    await warmupPaintPath(page, { label: "session-release" });
  });

  test.afterEach(async () => {
    await page?.context().close();
  });

  test("commit → re-open leaves only the new session alive", async () => {
    test.skip(setupError !== undefined, setupError);

    // The warm-up painted, so the open session holds overlay copies and
    // history; this also checks the snapshot finds the library's session and
    // its buffers at all.
    const painted = await sessions(page);
    expect(painted.live, "live edit sessions while painting").toBe(1);
    expect(
      painted.activeBytes,
      "no buffer under the active session",
    ).toBeGreaterThan(0);

    const reopened = (await page.evaluate(
      async () => await (window as any).__editPaintBenchCommitAndReenter(),
    )) as { ok: boolean; error?: string };
    expect(reopened.error ?? "").toBe("");

    const after = await sessions(page);
    expect(after.live, "live edit sessions after commit → re-open").toBe(1);
  });
});
