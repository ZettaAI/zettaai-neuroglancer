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
 * Edit-session GUARDS e2e: the protections that keep a tracer from losing an
 * open session or its layers by accident, driven through the BUILT app.
 *
 *   a. exit lock        `EditSessionHost.lockExit` / `unlockExit` gate the
 *                       topbar Exit-session button (tooltip on its wrapper), and
 *                       a lock that engages closes an open discard confirmation.
 *   b. layer lock       the session's layers can't be deleted, renamed or
 *                       retyped from NG's own UI; other layers can; the lock
 *                       lifts when the session ends.
 *   c. delete confirm   a trash-icon click asks (`window.confirm`, naming the
 *                       layer) before deleting; state replacement does not.
 *   d. group removal    "Remove layer group" asks only when it deletes layers,
 *                       names them, and is disabled while it would delete a
 *                       session layer.
 *   e. unload guard     `beforeunload` prompts while the open session has
 *                       unsaved strokes, and not otherwise.
 *
 * Same boot path as `edit_paint.e2e.ts` (fake-gcs fixtures → GCS route-rewrite
 * → `buildNgState` → auto-opened session), except that the ngState can carry
 * extra NON-session layers and a layer-group layout, which `openScenarioPage`
 * can't express. Each test opens its own page so a painted or exited session
 * never leaks into the next one.
 *
 * Setup that can't be satisfied offline (ungenerated fixtures, fake-gcs) SKIPS
 * with the reason — run `npm run e2e`.
 */

import {
  test,
  expect,
  type Browser,
  type Dialog,
  type Locator,
  type Page,
} from "@playwright/test";

import {
  buildNgState,
  type FixturesIndex,
  type Scenario,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  startFixtureGcs,
  warmupPaintPath,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";
import { installGcsRoute } from "#tests/editing/harness/gcs_route.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);

/** The portal's reason while a painting task keeps the tracer in the session. */
const TASK_EXIT_LOCK_REASON = "Complete the task to leave the edit session.";
/** `DEFAULT_EXIT_LOCK_REASON` in `edit_session_host.ts`. */
const DEFAULT_EXIT_LOCK_REASON =
  "The app embedding this viewer has locked leaving the edit session.";
/** `SESSION_LAYER_LOCK_REASON` in `session_layer_structure_lock.ts`. */
const SESSION_LAYER_LOCK_REASON =
  "Locked while this layer is part of the active edit session.";
/** `LAYER_GROUP_SESSION_LOCK_REASON` in `session_layer_structure_lock.ts`. */
const LAYER_GROUP_SESSION_LOCK_REASON =
  "Locked while this group shows the only copy of a layer in the active edit session.";
/** The `*_HIDE_INSTEAD` hints in `layer_deletion_confirmation.ts`. */
const LAYER_BAR_HIDE_INSTEAD =
  "To hide it instead, click its name in the layer bar.";
const LAYER_SIDE_PANEL_HIDE_INSTEAD =
  "To hide it instead, click its name in the layer bar or its eye icon in the layer list panel.";

/** Session layers: a locked reference image + the writable target. */
const SCENARIO: Scenario = {
  name: "guards: img-locked + cseg-target",
  layers: [
    { fixtureId: "img_u8_raw", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};
const SESSION_IMAGE = "img_u8_raw";
const SESSION_TARGET = "seg_u64_cseg";

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

// ---------------------------------------------------------------------------
// Page + dialog plumbing
// ---------------------------------------------------------------------------

interface SeenDialog {
  readonly type: string;
  readonly message: string;
}

/**
 * The ONE `dialog` listener of a page: records every dialog (so an unexpected
 * prompt can't slip by Playwright's silent auto-dismiss) and answers it with
 * the planned response, dismiss by default — the safe answer.
 */
class DialogRecorder {
  readonly seen: SeenDialog[] = [];
  private nextResponse: "accept" | "dismiss" = "dismiss";

  constructor(page: Page) {
    page.on("dialog", (dialog: Dialog) => {
      this.seen.push({ type: dialog.type(), message: dialog.message() });
      const response = this.nextResponse;
      this.nextResponse = "dismiss";
      void (response === "accept" ? dialog.accept() : dialog.dismiss());
    });
  }

  /** Answer the next dialog with `response` (then back to dismiss). */
  answerNext(response: "accept" | "dismiss"): void {
    this.nextResponse = response;
  }

  /** The dialogs seen since the last call. */
  take(): SeenDialog[] {
    return this.seen.splice(0, this.seen.length);
  }
}

interface GuardsPage {
  readonly page: Page;
  readonly dialogs: DialogRecorder;
}

type NgStateJson = Record<string, unknown> & {
  layers: Array<Record<string, unknown>>;
};

/** A plain image layer on the `img_u8_raw` fixture that is NOT in the session. */
function extraImageLayer(name: string): Record<string, unknown> {
  const fixture = fixtures!.fixtures.find((f) => f.id === "img_u8_raw")!;
  return { type: "image", source: fixture.source, tab: "source", name };
}

/**
 * `openScenarioPage` with a state hook: build the scenario's ngState, let
 * `transform` add non-session layers / a layout, then load it and wait for the
 * auto-opened session + the `__editPaintBench*` harness, exactly like the
 * shared opener. The dialog recorder is attached before the first navigation.
 */
async function openGuardsPage(
  browser: Browser,
  transform: (state: NgStateJson) => void = () => {},
): Promise<GuardsPage> {
  const context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
  });
  // The config's 10-minute test timeout is sized for pyodide paint runs; a UI
  // action that can't find its target should fail in seconds, not spin that
  // long. (Waits that need longer pass their own timeout.)
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (/error|warn|editPaintBench/i.test(m.text())) {
      console.log(`[page] ${m.text()}`);
    }
  });
  const dialogs = new DialogRecorder(page);
  await installGcsRoute(page, fakeGcs!.url);
  const state = buildNgState(SCENARIO, fixtures!) as NgStateJson;
  transform(state);
  await page.goto(`/#!${encodeURIComponent(JSON.stringify(state))}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForSessionAndHarness(page);
  return { page, dialogs };
}

async function waitForSessionAndHarness(page: Page): Promise<void> {
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
}

async function closeGuardsPage(g: GuardsPage | undefined): Promise<void> {
  // `close()` does not run beforeunload, so a dirty session can't hold it up.
  await g?.page
    .context()
    .close()
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// In-page probes (window.viewer)
// ---------------------------------------------------------------------------

interface HostProbe {
  active: boolean;
  unsaved: boolean;
  exitLockReason: string | undefined;
}

async function hostProbe(page: Page): Promise<HostProbe> {
  return page.evaluate(() => {
    const host = (window as any).viewer.editSessionHost;
    return {
      active: host.activeSession.value !== undefined,
      unsaved: host.hasUnsavedEdits() as boolean,
      exitLockReason: host.exitLockReason.value as string | undefined,
    };
  });
}

async function lockExit(page: Page, reason?: string): Promise<void> {
  await page.evaluate(
    (r) => (window as any).viewer.editSessionHost.lockExit(r),
    reason,
  );
}

async function unlockExit(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as any).viewer.editSessionHost.unlockExit(),
  );
}

/** Names of the viewer's (root) layers, in order. */
async function layerNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as any).viewer.layerManager.managedLayers as any[]).map(
      (l) => l.name as string,
    ),
  );
}

/** Number of layer groups in the root layout (1 for a non-stack layout). */
async function layerGroupCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const layout = (window as any).viewer.state.toJSON().layout;
    const count = (spec: any): number =>
      spec !== null && typeof spec === "object" && Array.isArray(spec.children)
        ? spec.children.reduce((n: number, c: any) => n + count(c), 0)
        : 1;
    return count(layout);
  });
}

/**
 * Paint one unsaved stroke through the real stack (the harness's deterministic
 * stamp) and return how much got painted.
 */
async function paintUnsavedStroke(page: Page, label: string): Promise<number> {
  await warmupPaintPath(page, { label });
  const r = (await page.evaluate(
    async () =>
      await (window as any).__editPaintBenchStampReadback({
        masked: false,
        radius: 8,
        clearFirst: true,
      }),
  )) as { paintedVoxels: number; error?: string };
  console.log(
    `[paint] ${label}: painted=${r.paintedVoxels}` +
      (r.error ? ` error=${r.error}` : ""),
  );
  return r.paintedVoxels;
}

async function paintedVoxels(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      ((window as any).__editPaintBenchReadback() as { paintedVoxels: number })
        .paintedVoxels,
  );
}

/** Exit the (not dirty) session through the topbar button and wait for it. */
async function exitCleanSessionViaTopbar(page: Page): Promise<void> {
  const exitButton = page.locator(".neuroglancer-editing-topbar-edit-button");
  await expect(exitButton).toHaveText(/Exit session/);
  await exitButton.click();
  await expect
    .poll(async () => (await hostProbe(page)).active, { timeout: 30_000 })
    .toBe(false);
  await expect(exitButton).toHaveText(/Edit/);
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

function exactText(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** The layer bar item of `name` (first layer group that shows it). */
function layerBarItem(page: Page, name: string): Locator {
  return page
    .locator(".neuroglancer-layer-item")
    .filter({
      has: page.locator(".neuroglancer-layer-item-label", {
        hasText: exactText(name),
      }),
    })
    .first();
}

/**
 * The layer bar trash icon of `name`: second icon of the item's button
 * container (after "Remove layer from this layer group"). Hovers the item
 * first — the container is `visibility: hidden` until the panel is hovered.
 */
async function layerBarDeleteIcon(page: Page, name: string): Promise<Locator> {
  const item = layerBarItem(page, name);
  await item.hover();
  return item
    .locator(".neuroglancer-layer-item-button-container > .neuroglancer-icon")
    .nth(1);
}

/** Open the side panel of `name` the way a user does: ctrl+click in the bar. */
async function showSidePanelOf(page: Page, name: string): Promise<void> {
  const selected = await page.evaluate(
    () =>
      (window as any).viewer.selectedLayer.layer?.name as string | undefined,
  );
  if (selected !== name) {
    await layerBarItem(page, name).click({ modifiers: ["Control"] });
  }
  await expect(sidePanelNameInput(page)).toHaveValue(name);
}

function sidePanelTitleBar(page: Page): Locator {
  return page.locator(".neuroglancer-layer-side-panel-title").first();
}

function sidePanelNameInput(page: Page): Locator {
  return sidePanelTitleBar(page).locator(
    "input.neuroglancer-layer-side-panel-name",
  );
}

function sidePanelTypeSelect(page: Page): Locator {
  return sidePanelTitleBar(page).locator(
    "select.neuroglancer-layer-side-panel-type",
  );
}

/** The side panel's trash icon: titled "Delete layer" or with the lock reason. */
function sidePanelDeleteIcon(page: Page): Locator {
  return sidePanelTitleBar(page).locator(
    `.neuroglancer-icon[title="Delete layer"], .neuroglancer-icon[title="${SESSION_LAYER_LOCK_REASON}"]`,
  );
}

/**
 * The layer list panel's trash icon of `name`, found by the row's name input.
 * Opens the panel and hovers the row.
 */
async function layerListDeleteIcon(page: Page, name: string): Promise<Locator> {
  await page.evaluate(() => {
    (window as any).viewer.layerListPanelState.location.visible = true;
  });
  const items = page.locator(".neuroglancer-layer-list-panel-item");
  await expect(items.first()).toBeVisible();
  const index = await items.evaluateAll(
    (els, n) =>
      els.findIndex(
        (el) =>
          (
            el.querySelector(
              "input.neuroglancer-layer-list-panel-item-name",
            ) as HTMLInputElement | null
          )?.value === n,
      ),
    name,
  );
  expect(
    index,
    `layer list panel has no item "${name}"`,
  ).toBeGreaterThanOrEqual(0);
  // The icon is `display: none` until its row is hovered.
  const item = items.nth(index);
  await item.hover();
  return item.locator(".neuroglancer-layer-list-panel-item-delete");
}

/**
 * Open the layer group menu of the group whose layer bar shows exactly
 * `names`, by right-clicking the bar's empty space, and return its
 * "Remove layer group" button.
 */
async function openGroupMenuRemoveButton(
  page: Page,
  names: readonly string[],
): Promise<Locator> {
  const index = await page
    .locator(".neuroglancer-layer-panel")
    .evaluateAll((panels, wanted) => {
      const key = [...wanted].sort().join("|");
      return panels.findIndex((panel) => {
        const shown = Array.from(
          panel.querySelectorAll(".neuroglancer-layer-item-label"),
        ).map((l) => l.textContent ?? "");
        return [...shown].sort().join("|") === key;
      });
    }, names);
  expect(
    index,
    `no layer group shows exactly ${JSON.stringify(names)}`,
  ).toBeGreaterThanOrEqual(0);
  const panel = page.locator(".neuroglancer-layer-panel").nth(index);
  const box = (await panel.boundingBox())!;
  await panel.click({
    button: "right",
    position: { x: box.width - 6, y: Math.min(box.height / 2, 10) },
  });
  const menu = page.locator(
    ".neuroglancer-layer-group-viewer-context-menu:visible",
  );
  await expect(menu).toHaveCount(1);
  return menu.locator(".neuroglancer-layer-group-menu-remove");
}

/**
 * Click a locked (`aria-disabled`) icon the way a user would anyway. `force`
 * skips Playwright's enabled check; the counter proves the click really
 * reached the icon, so "nothing happened" is not a missed click.
 */
async function clickLockedIcon(icon: Locator): Promise<void> {
  await icon.evaluate((el) => {
    el.addEventListener("click", () => {
      el.dataset.guardsClicks = String(
        Number(el.dataset.guardsClicks ?? 0) + 1,
      );
    });
    el.dataset.guardsClicks = "0";
  });
  await icon.click({ force: true });
  await expect(icon, "click did not reach the locked icon").toHaveAttribute(
    "data-guards-clicks",
    "1",
  );
}

/**
 * The selected layer's Source tab (every scenario layer opens on it): URL
 * input read-only, add-source icon locked, subsource checkboxes disabled —
 * or all of them open.
 */
async function expectSourceTabLocked(page: Page, locked: boolean) {
  const tab = page.locator(".neuroglancer-layer-data-sources-tab").first();
  const urlInput = tab
    .locator(".neuroglancer-layer-data-source-url-input")
    .first();
  const addSource = tab.locator(
    `.neuroglancer-icon[title="Add additional data source"], .neuroglancer-icon[title="${SESSION_LAYER_LOCK_REASON}"]`,
  );
  const checkboxes = tab.locator('input[type="checkbox"]');
  await expect(checkboxes.first()).toBeAttached();
  const n = await checkboxes.count();
  if (locked) {
    await expect(urlInput).toHaveClass(/neuroglancer-layer-data-source-locked/);
    await expect(urlInput.locator('[contenteditable="false"]')).toHaveCount(1);
    await expect(addSource).toHaveAttribute("aria-disabled", "true");
    for (let i = 0; i < n; i++) await expect(checkboxes.nth(i)).toBeDisabled();
  } else {
    await expect(urlInput).not.toHaveClass(
      /neuroglancer-layer-data-source-locked/,
    );
    await expect(urlInput.locator('[contenteditable="true"]')).toHaveCount(1);
    await expect(addSource).not.toHaveAttribute("aria-disabled", /.*/);
    for (let i = 0; i < n; i++) await expect(checkboxes.nth(i)).toBeEnabled();
  }
  return n;
}

// ---------------------------------------------------------------------------
// a. exit lock
// ---------------------------------------------------------------------------

test.describe("a. exit lock", () => {
  let g: GuardsPage | undefined;

  test.beforeEach(() => {
    test.skip(topSetupError !== undefined, topSetupError);
    test.setTimeout(8 * 60 * 1000);
  });

  test.afterEach(async () => {
    await closeGuardsPage(g);
    g = undefined;
  });

  test("lockExit disables Exit session with the reason as tooltip; unlockExit re-enables it", async ({
    browser,
  }) => {
    g = await openGuardsPage(browser);
    const { page } = g;
    const button = page.locator(".neuroglancer-editing-topbar-edit-button");
    const wrap = page.locator(".neuroglancer-editing-topbar-edit-button-wrap");
    const tooltip = page.locator(".neuroglancer-fast-tooltip");

    await expect(button).toHaveText(/Exit session/);
    await expect(button).toBeEnabled();
    await expect(wrap).toHaveAttribute("data-tooltip", "Exit edit session");

    await lockExit(page, TASK_EXIT_LOCK_REASON);
    await expect(button).toBeDisabled();
    await expect(wrap).toHaveAttribute("data-tooltip", TASK_EXIT_LOCK_REASON);

    // Hover the wrapper (the disabled button drops out of hit-testing): the
    // fast tooltip bubble shows the lock reason.
    await wrap.hover();
    await expect(tooltip).toHaveClass(/\bvisible\b/);
    await expect(tooltip).toHaveText(TASK_EXIT_LOCK_REASON);

    // A real click on the locked button's spot does not leave the session.
    const wrapBox = (await wrap.boundingBox())!;
    const cx = wrapBox.x + wrapBox.width / 2;
    const cy = wrapBox.y + wrapBox.height / 2;
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.className,
        [cx, cy],
      ),
      "the locked button's spot should hit the tooltip wrapper",
    ).toContain("neuroglancer-editing-topbar-edit-button-wrap");
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(500);
    expect((await hostProbe(page)).active, "locked exit left the session").toBe(
      true,
    );
    await expect(page.locator(".neuroglancer-confirm-dialog")).toHaveCount(0);

    // A blank reason falls back to the default text.
    await lockExit(page, "   ");
    await expect(wrap).toHaveAttribute(
      "data-tooltip",
      DEFAULT_EXIT_LOCK_REASON,
    );

    await unlockExit(page);
    await expect(button).toBeEnabled();
    await expect(wrap).toHaveAttribute("data-tooltip", "Exit edit session");
    await page.mouse.move(0, 0);
    await wrap.hover();
    await expect(tooltip).toHaveText("Exit edit session");
    expect(g.dialogs.take(), "no native dialog expected").toEqual([]);
  });

  test("with unsaved strokes the Exit confirmation opens, and lockExit closes it without discarding", async ({
    browser,
  }) => {
    g = await openGuardsPage(browser);
    const { page } = g;
    const button = page.locator(".neuroglancer-editing-topbar-edit-button");
    const confirm = page.locator(".neuroglancer-confirm-dialog");

    const painted = await paintUnsavedStroke(page, "exit-lock");
    expect(painted, "harness stamp painted nothing").toBeGreaterThan(0);
    expect((await hostProbe(page)).unsaved, "stroke not unsaved").toBe(true);

    await button.click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Exit edit session?");
    await expect(
      confirm.getByRole("button", { name: "Discard and exit" }),
    ).toBeVisible();

    await lockExit(page, TASK_EXIT_LOCK_REASON);
    await expect(confirm).toHaveCount(0);
    await expect(button).toBeDisabled();

    await page.waitForTimeout(1000);
    const probe = await hostProbe(page);
    expect(probe.active, "session was discarded").toBe(true);
    expect(probe.unsaved, "unsaved strokes were dropped").toBe(true);
    expect(probe.exitLockReason).toBe(TASK_EXIT_LOCK_REASON);
    expect(await paintedVoxels(page), "painted voxels were dropped").toBe(
      painted,
    );
    expect(g.dialogs.take(), "no native dialog expected").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// b. session layer protection
// ---------------------------------------------------------------------------

test.describe("b. session layer protection", () => {
  let g: GuardsPage | undefined;
  const OTHER = "extra_not_in_session";

  test.beforeEach(() => {
    test.skip(topSetupError !== undefined, topSetupError);
    test.setTimeout(8 * 60 * 1000);
  });

  test.afterEach(async () => {
    await closeGuardsPage(g);
    g = undefined;
  });

  test("session layers are locked in the layer bar, list panel and side panel; others are not; exit unlocks", async ({
    browser,
  }) => {
    g = await openGuardsPage(browser, (state) => {
      state.layers.push(extraImageLayer(OTHER));
    });
    const { page, dialogs } = g;
    expect(await layerNames(page)).toEqual([
      SESSION_IMAGE,
      SESSION_TARGET,
      OTHER,
    ]);

    // --- Layer bar: both session layers locked, the other layer not. ---
    for (const name of [SESSION_IMAGE, SESSION_TARGET]) {
      const icon = await layerBarDeleteIcon(page, name);
      await expect(icon).toHaveAttribute("aria-disabled", "true");
      await expect(icon).toHaveAttribute("title", SESSION_LAYER_LOCK_REASON);
      await clickLockedIcon(icon);
      await page.waitForTimeout(300);
      expect(await layerNames(page), `${name} deleted via layer bar`).toContain(
        name,
      );
      expect(dialogs.take(), `dialog for locked ${name}`).toEqual([]);
    }
    {
      const icon = await layerBarDeleteIcon(page, OTHER);
      await expect(icon).not.toHaveAttribute("aria-disabled", /.*/);
      await expect(icon).toHaveAttribute("title", "Delete this layer");
    }

    // --- Side panel of the writable session layer (selected by the scenario). ---
    await showSidePanelOf(page, SESSION_TARGET);
    await expect(sidePanelNameInput(page)).toHaveAttribute("readonly", "");
    await expect(sidePanelNameInput(page)).not.toBeEditable();
    await expect(sidePanelNameInput(page)).toHaveAttribute(
      "title",
      SESSION_LAYER_LOCK_REASON,
    );
    await expect(sidePanelTypeSelect(page)).toBeDisabled();
    await expect(sidePanelDeleteIcon(page)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    console.log(
      `[layer-lock] ${SESSION_TARGET} source tab: ` +
        `${await expectSourceTabLocked(page, true)} subsource checkboxes locked`,
    );
    // Typing into the read-only name changes nothing.
    await sidePanelNameInput(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type("_renamed");
    await page.keyboard.press("Enter");
    await expect(sidePanelNameInput(page)).toHaveValue(SESSION_TARGET);
    await clickLockedIcon(sidePanelDeleteIcon(page));
    await page.waitForTimeout(300);
    expect(await layerNames(page)).toContain(SESSION_TARGET);
    expect(dialogs.take(), "dialog for locked side-panel delete").toEqual([]);

    // --- Side panel of the reference session layer. ---
    await showSidePanelOf(page, SESSION_IMAGE);
    await expect(sidePanelNameInput(page)).not.toBeEditable();
    await expect(sidePanelTypeSelect(page)).toBeDisabled();
    await expect(sidePanelDeleteIcon(page)).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    // --- Side panel of the non-session layer: all enabled. ---
    await showSidePanelOf(page, OTHER);
    await expect(sidePanelNameInput(page)).toBeEditable();
    await expect(sidePanelNameInput(page)).toHaveAttribute(
      "title",
      "Rename layer",
    );
    await expect(sidePanelTypeSelect(page)).toBeEnabled();
    await expect(sidePanelDeleteIcon(page)).not.toHaveAttribute(
      "aria-disabled",
      /.*/,
    );
    await expect(sidePanelDeleteIcon(page)).toHaveAttribute(
      "title",
      "Delete layer",
    );
    await expectSourceTabLocked(page, false);

    // --- Layer list panel. ---
    {
      const icon = await layerListDeleteIcon(page, SESSION_TARGET);
      await expect(icon).toHaveAttribute("aria-disabled", "true");
      await clickLockedIcon(icon);
      await page.waitForTimeout(300);
      expect(await layerNames(page)).toContain(SESSION_TARGET);
      expect(dialogs.take(), "dialog for locked list-panel delete").toEqual([]);
      const other = await layerListDeleteIcon(page, OTHER);
      await expect(other).not.toHaveAttribute("aria-disabled", /.*/);
    }

    // --- Exit the session: the lock lifts everywhere. ---
    await exitCleanSessionViaTopbar(page);
    for (const name of [SESSION_IMAGE, SESSION_TARGET]) {
      const icon = await layerBarDeleteIcon(page, name);
      await expect(icon).not.toHaveAttribute("aria-disabled", /.*/);
      await expect(icon).toHaveAttribute("title", "Delete this layer");
    }
    await showSidePanelOf(page, SESSION_TARGET);
    await expect(sidePanelNameInput(page)).toBeEditable();
    await expect(sidePanelTypeSelect(page)).toBeEnabled();
    await expectSourceTabLocked(page, false);
    await expect(sidePanelDeleteIcon(page)).not.toHaveAttribute(
      "aria-disabled",
      /.*/,
    );
    {
      const icon = await layerListDeleteIcon(page, SESSION_TARGET);
      await expect(icon).not.toHaveAttribute("aria-disabled", /.*/);
    }
    // The unlocked former session layer now goes through the delete prompt.
    dialogs.answerNext("dismiss");
    await (await layerBarDeleteIcon(page, SESSION_TARGET)).click();
    await expect.poll(() => dialogs.seen.length).toBe(1);
    const [prompt] = dialogs.take();
    expect(prompt.type).toBe("confirm");
    expect(prompt.message).toContain(`Delete layer "${SESSION_TARGET}"?`);
    expect(await layerNames(page)).toContain(SESSION_TARGET);
  });
});

// ---------------------------------------------------------------------------
// c. delete confirmation
// ---------------------------------------------------------------------------

test.describe("c. delete confirmation", () => {
  let g: GuardsPage | undefined;
  const BAR = "extra_delete_from_bar";
  const SIDE = "extra_delete_from_side_panel";
  const LIST = "extra_delete_from_list_panel";
  const STATE = "extra_delete_by_state";

  test.beforeEach(() => {
    test.skip(topSetupError !== undefined, topSetupError);
    test.setTimeout(8 * 60 * 1000);
  });

  test.afterEach(async () => {
    await closeGuardsPage(g);
    g = undefined;
  });

  test("trash icons ask before deleting a non-session layer; state replacement does not", async ({
    browser,
  }) => {
    g = await openGuardsPage(browser, (state) => {
      for (const name of [BAR, SIDE, LIST, STATE]) {
        state.layers.push(extraImageLayer(name));
      }
    });
    const { page, dialogs } = g;

    // --- Layer bar: dismiss keeps, accept deletes. ---
    {
      dialogs.answerNext("dismiss");
      await (await layerBarDeleteIcon(page, BAR)).click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      const [prompt] = dialogs.take();
      expect(prompt.type).toBe("confirm");
      expect(prompt.message).toBe(
        `Delete layer "${BAR}"? This can't be undone. ${LAYER_BAR_HIDE_INSTEAD}`,
      );
      await page.waitForTimeout(300);
      expect(await layerNames(page), "dismiss deleted the layer").toContain(
        BAR,
      );

      dialogs.answerNext("accept");
      await (await layerBarDeleteIcon(page, BAR)).click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      expect(dialogs.take()[0].message).toContain(`Delete layer "${BAR}"?`);
      await expect
        .poll(() => layerNames(page), { message: "accept kept the layer" })
        .not.toContain(BAR);
    }

    // --- Side panel. ---
    {
      await showSidePanelOf(page, SIDE);
      dialogs.answerNext("dismiss");
      await sidePanelDeleteIcon(page).click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      const [prompt] = dialogs.take();
      expect(prompt.type).toBe("confirm");
      expect(prompt.message).toBe(
        `Delete layer "${SIDE}"? This can't be undone. ${LAYER_SIDE_PANEL_HIDE_INSTEAD}`,
      );
      await page.waitForTimeout(300);
      expect(await layerNames(page)).toContain(SIDE);

      dialogs.answerNext("accept");
      await sidePanelDeleteIcon(page).click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      expect(dialogs.take()[0].message).toContain(`Delete layer "${SIDE}"?`);
      await expect.poll(() => layerNames(page)).not.toContain(SIDE);
    }

    // --- Layer list panel, with the layer hidden: the prompt drops the hint. ---
    {
      await layerBarItem(page, LIST).click(); // toggles visibility off
      await expect
        .poll(() =>
          page.evaluate(
            (n) =>
              (window as any).viewer.layerManager.getLayerByName(n).visible,
            LIST,
          ),
        )
        .toBe(false);
      dialogs.answerNext("dismiss");
      await (await layerListDeleteIcon(page, LIST)).click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      const [prompt] = dialogs.take();
      expect(prompt.type).toBe("confirm");
      expect(prompt.message).toBe(
        `Delete layer "${LIST}"? This can't be undone.`,
      );
      await page.waitForTimeout(300);
      expect(await layerNames(page)).toContain(LIST);

      dialogs.answerNext("accept");
      await (await layerListDeleteIcon(page, LIST)).click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      dialogs.take();
      await expect.poll(() => layerNames(page)).not.toContain(LIST);
    }

    // --- Programmatic deletion by replacing the viewer state: no prompt. ---
    {
      await page.evaluate((n) => {
        const viewer = (window as any).viewer;
        const json = viewer.state.toJSON();
        json.layers = json.layers.filter((l: any) => l.name !== n);
        viewer.state.restoreState(json);
      }, STATE);
      await expect.poll(() => layerNames(page)).not.toContain(STATE);
      await page.waitForTimeout(500);
      expect(dialogs.take(), "state replacement prompted").toEqual([]);
      console.log(
        `[delete-confirm] after state replacement: layers=${JSON.stringify(
          await layerNames(page),
        )} session=${JSON.stringify(await hostProbe(page))}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// d. Remove layer group
// ---------------------------------------------------------------------------

test.describe("d. remove layer group", () => {
  let g: GuardsPage | undefined;
  const SHARED = "extra_shared";
  const SINGLE = "extra_single";
  const MULTI_1 = "extra_multi_1";
  const MULTI_2 = "extra_multi_2";

  // Column stack of five groups (full-width layer bars, so the empty space to
  // right-click is easy to hit):
  const MAIN_GROUP = [SESSION_TARGET, SHARED];
  const SHARED_GROUP = [SHARED]; // everything shown elsewhere → no prompt
  const SINGLE_GROUP = [SINGLE]; // deletes one layer → names it
  const MULTI_GROUP = [MULTI_1, MULTI_2, SESSION_TARGET]; // deletes two
  const LOCK_GROUP = [SESSION_IMAGE]; // only copy of a session layer → disabled

  test.beforeEach(() => {
    test.skip(topSetupError !== undefined, topSetupError);
    test.setTimeout(8 * 60 * 1000);
  });

  test.afterEach(async () => {
    await closeGuardsPage(g);
    g = undefined;
  });

  test("prompts only when removal deletes layers, names them, and is locked for the only copy of a session layer", async ({
    browser,
  }) => {
    g = await openGuardsPage(browser, (state) => {
      for (const name of [SHARED, SINGLE, MULTI_1, MULTI_2]) {
        state.layers.push(extraImageLayer(name));
      }
      state.layout = {
        type: "column",
        children: [
          MAIN_GROUP,
          SHARED_GROUP,
          SINGLE_GROUP,
          MULTI_GROUP,
          LOCK_GROUP,
        ].map((layers) => ({ type: "viewer", layers, layout: "xy" })),
      };
    });
    const { page, dialogs } = g;
    expect(await layerGroupCount(page)).toBe(5);

    // --- Only copy of a session layer: disabled with the reason, no prompt. ---
    {
      const remove = await openGroupMenuRemoveButton(page, LOCK_GROUP);
      await expect(remove).toBeDisabled();
      await expect(remove).toHaveAttribute(
        "title",
        LAYER_GROUP_SESSION_LOCK_REASON,
      );
      await remove.click({ force: true });
      await page.waitForTimeout(300);
      expect(dialogs.take()).toEqual([]);
      expect(await layerGroupCount(page)).toBe(5);
      await page.keyboard.press("Escape");
    }

    // --- Removal deletes nothing: no prompt, group removed, layer kept. ---
    {
      const remove = await openGroupMenuRemoveButton(page, SHARED_GROUP);
      await expect(remove).toBeEnabled();
      await remove.click();
      await expect.poll(() => layerGroupCount(page)).toBe(4);
      expect(dialogs.take(), "prompt for a removal deleting nothing").toEqual(
        [],
      );
      expect(await layerNames(page)).toContain(SHARED);
    }

    // --- Deletes one layer: names it; dismiss keeps, accept removes. ---
    {
      dialogs.answerNext("dismiss");
      let remove = await openGroupMenuRemoveButton(page, SINGLE_GROUP);
      await remove.click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      const [prompt] = dialogs.take();
      expect(prompt.type).toBe("confirm");
      expect(prompt.message).toBe(
        `Remove this layer group? This also deletes layer "${SINGLE}", which no other layer group shows. This can't be undone.`,
      );
      await page.waitForTimeout(300);
      expect(await layerGroupCount(page)).toBe(4);
      expect(await layerNames(page)).toContain(SINGLE);
      await page.keyboard.press("Escape");

      dialogs.answerNext("accept");
      remove = await openGroupMenuRemoveButton(page, SINGLE_GROUP);
      await remove.click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      dialogs.take();
      await expect.poll(() => layerGroupCount(page)).toBe(3);
      expect(await layerNames(page)).not.toContain(SINGLE);
    }

    // --- Deletes two layers (a shared session layer is not among them). ---
    {
      dialogs.answerNext("accept");
      const remove = await openGroupMenuRemoveButton(page, MULTI_GROUP);
      await expect(remove).toBeEnabled();
      await remove.click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      const [prompt] = dialogs.take();
      expect(prompt.type).toBe("confirm");
      expect(prompt.message).toBe(
        `Remove this layer group? This also deletes 2 layers that no other layer group shows: "${MULTI_1}" and "${MULTI_2}". This can't be undone.`,
      );
      await expect.poll(() => layerGroupCount(page)).toBe(2);
      const names = await layerNames(page);
      expect(names).not.toContain(MULTI_1);
      expect(names).not.toContain(MULTI_2);
      expect(names).toContain(SESSION_TARGET);
      expect((await hostProbe(page)).active, "session closed").toBe(true);
    }

    // --- After exiting the session the locked group asks like any other. ---
    {
      await exitCleanSessionViaTopbar(page);
      dialogs.answerNext("dismiss");
      const remove = await openGroupMenuRemoveButton(page, LOCK_GROUP);
      await expect(remove).toBeEnabled();
      await expect(remove).not.toHaveAttribute("title", /.+/);
      await remove.click();
      await expect.poll(() => dialogs.seen.length).toBe(1);
      expect(dialogs.take()[0].message).toContain(
        `This also deletes layer "${SESSION_IMAGE}"`,
      );
      expect(await layerGroupCount(page)).toBe(2);
      await page.keyboard.press("Escape");
    }
  });
});

// ---------------------------------------------------------------------------
// e. unload guard
// ---------------------------------------------------------------------------

test.describe("e. unload guard", () => {
  let g: GuardsPage | undefined;

  test.beforeEach(() => {
    test.skip(topSetupError !== undefined, topSetupError);
    test.setTimeout(8 * 60 * 1000);
  });

  test.afterEach(async () => {
    await closeGuardsPage(g);
    g = undefined;
  });

  /**
   * Chromium shows a `beforeunload` prompt only for a page with a user gesture
   * (sticky activation), so give it a TRUSTED click on a harmless spot (the
   * session layer's read-only name input) before reloading. Without it a
   * "no prompt" result would prove nothing.
   */
  async function giveUserActivation(page: Page): Promise<void> {
    await sidePanelNameInput(page).click();
    expect(
      await page.evaluate(() => navigator.userActivation.hasBeenActive),
    ).toBe(true);
  }

  /** Mark the document, reload, and report whether it actually reloaded. */
  async function reloadAndObserve(
    page: Page,
    dialogs: DialogRecorder,
  ): Promise<{ reloaded: boolean; dialogs: SeenDialog[] }> {
    await page.evaluate(() => {
      (window as any).__guardsDocumentMarker = true;
    });
    const reload = page
      .reload({ waitUntil: "domcontentloaded", timeout: 15_000 })
      .then(
        () => "done",
        (e: Error) => `error: ${e.message.split("\n")[0]}`,
      );
    // Either the reload completes or a prompt stops it (then the reload hangs
    // until its timeout, which is fine — we only need the dialog).
    const outcome = await Promise.race([
      reload,
      expect
        .poll(() => dialogs.seen.length, { timeout: 15_000 })
        .toBeGreaterThan(0)
        .then(
          () => "dialog",
          () => "no-dialog",
        ),
    ]);
    if (outcome === "dialog") {
      await page.waitForTimeout(1000);
    } else {
      console.log(`[unload] reload outcome: ${outcome}`);
    }
    const marker = await page
      .evaluate(() => (window as any).__guardsDocumentMarker === true)
      .catch(() => false);
    return { reloaded: !marker, dialogs: dialogs.take() };
  }

  test("no prompt on reload without unsaved strokes", async ({ browser }) => {
    g = await openGuardsPage(browser);
    const { page, dialogs } = g;
    expect((await hostProbe(page)).unsaved).toBe(false);
    await showSidePanelOf(page, SESSION_TARGET);
    await giveUserActivation(page);
    const r = await reloadAndObserve(page, dialogs);
    expect(r.dialogs, "unexpected beforeunload prompt").toEqual([]);
    expect(r.reloaded, "page did not reload").toBe(true);
  });

  test("unsaved stroke prompts on reload; dismiss keeps the page; after discarding no prompt", async ({
    browser,
  }) => {
    g = await openGuardsPage(browser);
    const { page, dialogs } = g;
    const painted = await paintUnsavedStroke(page, "unload");
    expect(painted, "harness stamp painted nothing").toBeGreaterThan(0);
    expect((await hostProbe(page)).unsaved, "stroke not unsaved").toBe(true);

    await showSidePanelOf(page, SESSION_TARGET);
    await giveUserActivation(page);
    dialogs.answerNext("dismiss");
    const blocked = await reloadAndObserve(page, dialogs);
    expect(blocked.dialogs.map((d) => d.type)).toEqual(["beforeunload"]);
    expect(blocked.reloaded, "dismissed prompt still reloaded").toBe(false);
    const probe = await hostProbe(page);
    expect(probe.active).toBe(true);
    expect(probe.unsaved).toBe(true);
    expect(await paintedVoxels(page)).toBe(painted);

    // Saving needs the Zetta backend (no fake here); discarding the strokes
    // through the Exit confirmation is the other way to have nothing unsaved.
    await page.locator(".neuroglancer-editing-topbar-edit-button").click();
    const confirm = page.locator(".neuroglancer-confirm-dialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Discard and exit" }).click();
    await expect
      .poll(async () => (await hostProbe(page)).active, { timeout: 30_000 })
      .toBe(false);
    expect((await hostProbe(page)).unsaved).toBe(false);

    const clean = await reloadAndObserve(page, dialogs);
    expect(clean.dialogs, "prompt after discarding").toEqual([]);
    expect(clean.reloaded, "page did not reload").toBe(true);
  });
});
