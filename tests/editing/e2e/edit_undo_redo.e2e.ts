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
 * Undo/redo of a painted stroke, end to end (TM-494 item 14).
 *
 * Redo had no coverage at any level, so "redo doesn't work" could not be
 * localized by reading: the stroke, the journal, the replay closure and the
 * hotkey delivery are four separate suspects and only the real stack exercises
 * all four. This drives a deterministic stamp, then undo, then redo, reading
 * the painted voxels back each time — and separately checks that the keyboard
 * shortcut reaches the action, which is the one part a direct `session.redo()`
 * call would skip.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

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

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SCENARIO: Scenario = {
  name: "undo-redo",
  layers: [
    { fixtureId: "img_u8_raw", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};

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
 * Painted-voxel count of the target layer, once it stops moving.
 *
 * The patch store settles after the call that changed it resolves — the same
 * reason the stamp helper polls rather than reading once — so an immediate read
 * reports the previous state and makes undo look like it did nothing.
 */
async function paintedVoxels(page: Page, timeoutMs = 8000): Promise<number> {
  return (await page.evaluate(async (timeout) => {
    const read = () =>
      (
        window as unknown as {
          __editPaintBenchReadback: () => { paintedVoxels: number };
        }
      ).__editPaintBenchReadback().paintedVoxels;
    const started = performance.now();
    let previous = -1;
    let stable = 0;
    while (performance.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const count = read();
      if (count === previous) {
        if (++stable >= 3) return count;
      } else {
        stable = 0;
      }
      previous = count;
    }
    return previous;
  }, timeoutMs)) as number;
}

/** Count and voxel-set signature of the target's painted voxels, once settled. */
async function settledReadback(
  page: Page,
): Promise<{ paintedVoxels: number; signature: string }> {
  await paintedVoxels(page);
  return (await page.evaluate(() => {
    const { paintedVoxels: count, signature } = (
      window as unknown as {
        __editPaintBenchReadback: () => {
          paintedVoxels: number;
          signature: string;
        };
      }
    ).__editPaintBenchReadback();
    return { paintedVoxels: count, signature };
  })) as { paintedVoxels: number; signature: string };
}

/** The read-back of a target with nothing painted (FNV-1a offset basis). */
const EMPTY_READBACK = { paintedVoxels: 0, signature: "811c9dc5" };

async function hasUnsavedEdits(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as any).viewer.editSessionHost.hasUnsavedEdits() as boolean,
  );
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (globalThis as any).viewer.editSessionHost.activeSession.value.undo();
  });
}

/** `{ canUndo, canRedo }` as the topbar buttons read it. */
async function history(
  page: Page,
): Promise<{ canUndo: boolean; canRedo: boolean }> {
  return (await page.evaluate(() => {
    const session = (globalThis as any).viewer?.editSessionHost?.activeSession
      ?.value;
    const snapshot = session?.getHistory?.();
    return {
      canUndo: snapshot?.canUndo === true,
      canRedo: snapshot?.canRedo === true,
    };
  })) as { canUndo: boolean; canRedo: boolean };
}

/**
 * Paint one stamp at a position the warm-up never touched, and report the
 * settled counts either side of it.
 *
 * `warmupPaintPath` leaves nothing behind (its strokes are undone), so `before`
 * is the painted count of whatever the test drew itself.
 */
async function stampAside(
  page: Page,
): Promise<{ before: number; after: number }> {
  const before = await paintedVoxels(page);
  const stamped = (await page.evaluate(
    async () =>
      await (
        window as unknown as {
          __editPaintBenchStampReadback: (i: unknown) => Promise<{
            strokeFired: boolean;
          }>;
        }
      ).__editPaintBenchStampReadback({
        radius: 8,
        fracX: 0.3,
        fracY: 0.7,
        prime: 0,
      }),
  )) as { strokeFired: boolean };
  expect(stamped.strokeFired).toBe(true);
  const after = await paintedVoxels(page);
  expect(after).toBeGreaterThan(before);
  return { before, after };
}

test.describe("undo / redo of a painted stroke", () => {
  let page: Page;

  /**
   * A FRESH page per test. Sharing one accumulates journal entries and patch
   * state across tests, which makes every count relative to a history nobody
   * wrote down — the first version of this file read a leftover warm-up stroke
   * as an undo that had not reverted.
   */
  test.beforeEach(async ({ browser }) => {
    if (setupError !== undefined) return;
    page = await openScenarioPage(browser, {
      scenario: SCENARIO,
      fixtures: fixtures!,
      fakeGcsUrl: fakeGcs!.url,
      appPort: PORT,
    });
    await warmupPaintPath(page, { label: "undo-redo" });
  });

  test.afterEach(async () => {
    await page?.context().close();
  });

  test("redo replays a stroke that undo rolled back", async () => {
    test.skip(setupError !== undefined, setupError);

    // The warm-up is undone, so `canUndo` is this stroke's alone.
    await stampAside(page);
    expect(await history(page)).toEqual({ canUndo: true, canRedo: false });

    await page.evaluate(async () => {
      await (
        globalThis as any
      ).viewer.editSessionHost.activeSession.value.undo();
    });
    expect(await history(page)).toMatchObject({ canRedo: true });

    await page.evaluate(async () => {
      await (
        globalThis as any
      ).viewer.editSessionHost.activeSession.value.redo();
    });

    expect(await history(page)).toMatchObject({
      canUndo: true,
      canRedo: false,
    });
  });

  /**
   * Undo removes exactly the stroke's voxels and redo restores exactly them —
   * the same SET (signature), not just the same count.
   *
   * Starts from a clean session (`warmupPaintPath` undoes its strokes), so the
   * counts are absolute. This test was `fixme` for a "redo over-count of 49"
   * that was the warm-up's own paint: the warm-up used to empty only the render
   * mirror, hiding paint the session still held, and before TM-373 (#279) an
   * undo rescanned the whole chunk and rediscovered it.
   */
  test("undo clears the voxels it rolled back, and redo brings them back", async () => {
    test.skip(setupError !== undefined, setupError);

    expect(await hasUnsavedEdits(page)).toBe(false);
    expect(await settledReadback(page)).toEqual(EMPTY_READBACK);

    await stampAside(page);
    const stamped = await settledReadback(page);
    expect(stamped.paintedVoxels).toBeGreaterThan(0);

    await undo(page);
    expect(await settledReadback(page)).toEqual(EMPTY_READBACK);
    expect(await hasUnsavedEdits(page)).toBe(false);

    await page.evaluate(async () => {
      await (
        globalThis as any
      ).viewer.editSessionHost.activeSession.value.redo();
    });
    expect(await settledReadback(page)).toEqual(stamped);
    expect(await hasUnsavedEdits(page)).toBe(true);
  });

  /**
   * The journal is only half the story: this is the half that exercises the
   * keybinding, the event map and the action listener, which a direct
   * `session.redo()` call skips entirely. Asserted on the journal rather than
   * on painted voxels so it reports ONLY whether the action fired.
   */
  test("the redo shortcut fires the action with the canvas focused", async () => {
    test.skip(setupError !== undefined, setupError);

    await stampAside(page);
    await page.evaluate(async () => {
      await (
        globalThis as any
      ).viewer.editSessionHost.activeSession.value.undo();
    });
    expect(await history(page)).toMatchObject({ canRedo: true });

    // Focus is dropped rather than moved onto the canvas with a click: a click
    // there paints, and a new stroke records a journal entry, which drops the
    // redo stack and would make this read as a redo that never fired.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+KeyZ" : "Control+Shift+KeyZ",
    );
    await page.waitForTimeout(1000);

    expect(await history(page)).toMatchObject({ canRedo: false });
  });

  /**
   * The suspicion reading left behind: `KeyboardEventBinder.shouldIgnoreEvent`
   * drops every Ctrl/Alt/Meta shortcut whose target is a `<button>`, and the
   * topbar's own Undo button is exactly such a target — so the most natural
   * gesture for trying redo (click Undo, then press the shortcut) would be
   * swallowed. If this fails while the canvas case passes, FOCUS is the bug.
   */
  test("the redo shortcut fires the action with a topbar button focused", async () => {
    test.skip(setupError !== undefined, setupError);

    await stampAside(page);

    const undoButton = page.locator('button[aria-label*="Undo" i]').first();
    await undoButton.click();
    await page.waitForTimeout(1000);
    expect(await history(page)).toMatchObject({ canRedo: true });

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+KeyZ" : "Control+Shift+KeyZ",
    );
    await page.waitForTimeout(1000);

    expect(await history(page)).toMatchObject({ canRedo: false });
  });
});

void HERE;
