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
 * The key hints against the real viewer. Unit tests cover the formatting, but
 * only this shows that a key reaches its action with a data panel focused, that
 * the tooltip and strip show that same key, and that H opens the sheet.
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
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);

const SCENARIO: Scenario = {
  name: "hotkey-hints",
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

const activeTool = (page: Page) =>
  page.evaluate(
    () => (globalThis as any).viewer.editSessionHost.activeToolId.value,
  ) as Promise<string | undefined>;

async function focusDataPanel(page: Page) {
  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(
      ".neuroglancer-rendered-data-panel",
    );
    panel?.focus();
  });
}

test.describe("hotkey hints", () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    if (setupError !== undefined) return;
    page = await openScenarioPage(browser, {
      scenario: SCENARIO,
      fixtures: fixtures!,
      fakeGcsUrl: fakeGcs!.url,
      appPort: PORT,
    });
    await page.waitForTimeout(1000);
    await page.keyboard.press("Escape");
    await focusDataPanel(page);
  });

  test.afterEach(async () => {
    await page?.context().close();
  });

  // Tools take Ctrl (as before TM-517): plain letters stay neuroglancer's in
  // the data panels, where E and R rotate the view.
  test("Ctrl picks a tool with a data panel focused", async () => {
    test.skip(setupError !== undefined, setupError);
    for (const [key, toolId] of [
      ["Control+KeyB", "painting.brush"],
      ["Control+KeyE", "painting.erase"],
      ["Control+KeyG", "painting.fill"],
    ] as const) {
      await page.keyboard.press(key);
      expect(await activeTool(page)).toBe(toolId);
    }
    await page.keyboard.press("Control+KeyV");
    expect(await activeTool(page)).toBeUndefined();
  });

  test("plain E still rotates the view during a session, and Ctrl+F is the browser's", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.keyboard.press("Control+KeyB");
    const orientation = () =>
      page.evaluate(() =>
        Array.from(
          (globalThis as any).viewer.navigationState.pose.orientation
            .orientation as Float32Array,
        ).join(","),
      );
    const before = await orientation();
    const panelBox = (await page
      .locator(".neuroglancer-rendered-data-panel")
      .first()
      .boundingBox())!;
    await page.mouse.move(
      panelBox.x + panelBox.width / 2,
      panelBox.y + panelBox.height / 2,
    );
    await page.keyboard.press("KeyE");
    await expect.poll(orientation).not.toBe(before);
    expect(await activeTool(page)).toBe("painting.brush");
    await page.keyboard.press("Control+KeyF");
    expect(await activeTool(page)).toBe("painting.brush");
  });

  // Before a session there is no topbar of tools yet: the Edit button itself
  // names the key that opens the entry modal.
  // Ctrl+E on a Mac too: Cmd+E is often claimed before the page sees it.
  test("the Edit button names Ctrl+E before a session", async () => {
    test.skip(setupError !== undefined, setupError);
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await page.evaluate(() =>
      (globalThis as any).viewer.editSessionHost.discardActive(),
    );
    await page.locator(".neuroglancer-editing-topbar-edit-button-wrap").hover();
    const tooltip = page.locator(".neuroglancer-fast-tooltip.visible");
    await expect(tooltip.locator(".neuroglancer-key-chip")).toHaveText(
      mac ? ["⌃", "E"] : ["Ctrl", "E"],
    );
    // Only the one key: the region key is in the sheet, not this hint.
    await expect(tooltip).toHaveText(
      `Open the edit-session entry modal${mac ? "⌃" : "Ctrl"}E`,
    );
  });

  test("the tooltip shows the tool's key as a key cap", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.locator('button[aria-label^="Brush"]').hover();
    const tooltip = page.locator(".neuroglancer-fast-tooltip.visible");
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await expect(tooltip.locator(".neuroglancer-key-chip")).toHaveText(
      mac ? ["⌃", "B"] : ["Ctrl", "B"],
    );
    await expect(tooltip).toContainText("Paint voxels");
    await page.screenshot({ path: test.info().outputPath("tooltip.png") });
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  });

  test("the strip follows the active tool", async () => {
    test.skip(setupError !== undefined, setupError);
    const strip = page.locator(".neuroglancer-mode-strip");
    await expect(strip).toContainText("Edit session");
    await page.keyboard.press("Control+KeyB");
    await expect(strip).toContainText("Brush");
    await expect(strip).toContainText("Size");
    await expect(strip).not.toContainText("Choose setting");
    // Inside the data panels: it must not cover a side panel's controls.
    const stripBox = (await strip.boundingBox())!;
    const panelBox = (await page
      .locator(".neuroglancer-rendered-data-panel")
      .first()
      .boundingBox())!;
    expect(stripBox.x).toBeGreaterThanOrEqual(panelBox.x);
    await page.screenshot({ path: test.info().outputPath("strip.png") });
    await page.keyboard.press("Control+KeyG");
    await expect(strip).toContainText("Fill");
    await expect(strip).not.toContainText("Size");
    await page.keyboard.press("Escape");
    await expect(strip).toContainText("Edit session");
  });

  test("the tool panel lists its keys, open by default", async () => {
    test.skip(setupError !== undefined, setupError);
    const dataPanel = page.locator(".neuroglancer-rendered-data-panel").first();
    const heightBefore = (await dataPanel.boundingBox())!.height;
    await page.keyboard.press("Control+KeyB");
    await expect(page.locator(".neuroglancer-tool-panel-keys")).toBeVisible();
    // A tall tool panel scrolls by itself; it must not resize the data panels.
    expect((await dataPanel.boundingBox())!.height).toBe(heightBefore);
    const keys = page.locator(".neuroglancer-tool-panel-keys");
    await expect(keys).toHaveAttribute("open", "");
    // The keys live in the list and the ⓘ hint, not as caps beside the label.
    await expect(
      page.locator(".neuroglancer-tool-panel-row .neuroglancer-key-chip"),
    ).toHaveCount(0);
    await expect(keys.locator("dt").first()).toHaveText("− / +");
    await expect(keys.locator("dd").first()).toHaveText(
      "smaller / larger brush",
    );
    await expect(keys.locator("dt").nth(1)).toHaveText("I");
    // Shift is named: "{" would read as a key of its own.
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await expect(keys.locator("dt").nth(2)).toHaveText(
      mac ? "⇧[ / ⇧]" : "Shift+[ / Shift+]",
    );
    await page.screenshot({ path: test.info().outputPath("panel.png") });
  });

  // TM-517: every tool the topbar offers has its list, and each list names
  // only keys that do something in that tool.
  test("every tool's panel lists its keys", async () => {
    test.skip(setupError !== undefined, setupError);
    const visibleList = page.locator(".neuroglancer-tool-panel-keys:visible");
    const meanings = async () =>
      (await visibleList.locator("dd").allTextContents()).join(" | ");

    await page.keyboard.press("Control+KeyV");
    await expect
      .poll(meanings)
      .toBe(
        "brush | eraser | fill | z-extrapolation | undo the last edit | " +
          "redo the undone edit | save all edited layers | all shortcuts",
      );

    const sizeAndSettings =
      "move between the settings | change the selected setting | " +
      "undo the last edit | redo the undone edit | save all edited layers | " +
      "back to the cursor | all shortcuts";
    await page.keyboard.press("Control+KeyB");
    await expect
      .poll(meanings)
      .toBe(
        "smaller / larger brush | fill inside on / off | " +
          "previous / next target value | " +
          sizeAndSettings,
      );
    await page.keyboard.press("Control+KeyE");
    await expect
      .poll(meanings)
      .toBe("smaller / larger brush | " + sizeAndSettings);
    await page.keyboard.press("Control+KeyG");
    await expect
      .poll(meanings)
      .toBe("previous / next target value | " + sizeAndSettings);
    await page.keyboard.press("Control+KeyX");
    expect(await activeTool(page)).toBe("z-extrapolation");
    await expect
      .poll(meanings)
      .toBe(
        "undo the last edit | redo the undone edit | save all edited layers | " +
          "back to the cursor | all shortcuts",
      );
  });

  test("the size keys work in the eraser and the value keys in fill", async () => {
    test.skip(setupError !== undefined, setupError);
    const state = () =>
      page.evaluate(() => {
        const painting = (
          globalThis as any
        ).viewer.editSessionHost.painting.state.getState();
        return { radius: painting.radius, value: String(painting.activeValue) };
      });
    await page.keyboard.press("Control+KeyE");
    const beforeErase = await state();
    await page.keyboard.press("Shift+Equal");
    expect((await state()).radius).toBeGreaterThan(beforeErase.radius);

    await page.keyboard.press("Control+KeyG");
    await expect(
      page.locator(
        ".neuroglancer-painting-fill-panel .neuroglancer-tool-panel-keys",
      ),
    ).toBeVisible();
    const beforeFill = BigInt((await state()).value);
    await page.keyboard.press("Shift+BracketRight");
    expect(BigInt((await state()).value)).toBe(beforeFill + 1n);
  });

  test("{ and } work with the tool panel closed", async () => {
    test.skip(setupError !== undefined, setupError);
    const value = () =>
      page.evaluate(() =>
        String(
          (globalThis as any).viewer.editSessionHost.painting.state.getState()
            .activeValue,
        ),
      );
    await page.keyboard.press("Control+KeyB");
    const panel = page.locator(".neuroglancer-painting-brush-panel");
    await expect(panel).toBeVisible();
    await page.evaluate(() => {
      (globalThis as any).viewer.editSessionHost.toggleToolPanel(
        "painting.brush",
      );
    });
    await expect(panel).toHaveCount(0);
    expect(await activeTool(page)).toBe("painting.brush");
    // The closed panel publishes no value parameter, so this is the path that
    // used to do nothing.
    expect(
      await page.evaluate(() =>
        (globalThis as any).viewer.editSessionHost.painting.paramCursor
          .getDescriptors()
          .map((descriptor: { id: string }) => descriptor.id),
      ),
    ).not.toContain("value");
    await focusDataPanel(page);
    const before = BigInt(await value());
    await page.keyboard.press("Shift+BracketRight");
    await expect.poll(async () => BigInt(await value())).toBe(before + 1n);
  });

  test("Fill inside starts on, I switches it, and its hint names the key", async () => {
    test.skip(setupError !== undefined, setupError);
    const fillClosedPaths = () =>
      page.evaluate(
        () =>
          (globalThis as any).viewer.editSessionHost.painting.state.getState()
            .fillClosedPaths as boolean,
      );
    await page.keyboard.press("Control+KeyB");
    const toggle = page.getByRole("switch", { name: "Fill inside" });
    await expect(toggle).toBeVisible();
    // On by default.
    const before = await fillClosedPaths();
    expect(before).toBe(true);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await focusDataPanel(page);
    await page.keyboard.press("KeyI");
    expect(await fillClosedPaths()).toBe(!before);
    await expect(toggle).toHaveAttribute("aria-checked", String(!before));
    await page.keyboard.press("KeyI");
    expect(await fillClosedPaths()).toBe(before);

    await page
      .locator(".neuroglancer-tool-panel-row", { hasText: "Fill inside" })
      .locator(".neuroglancer-param-hint")
      .hover();
    const tooltip = page.locator(".neuroglancer-fast-tooltip.visible");
    await expect(tooltip.locator(".neuroglancer-key-chip")).toHaveText("I");
    await expect(tooltip).toContainText(
      "Drawing around an object in one stroke",
    );

    // The Size hint shows its pair of keys the same way.
    await page.mouse.move(0, 0);
    await page
      .locator(".neuroglancer-tool-panel-row", { hasText: "Size" })
      .locator(".neuroglancer-param-hint")
      .hover();
    await expect(tooltip.locator(".neuroglancer-key-chip")).toHaveText([
      "−",
      "+",
    ]);

    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    await expect(
      sheet.locator(".neuroglancer-shortcut-now .neuroglancer-shortcut-row", {
        hasText: "Fill inside",
      }),
    ).toHaveText("Fill insideI");
    await sheet.getByLabel("Search shortcuts").fill("inside");
    await expect(sheet.locator(".neuroglancer-shortcut-row")).toHaveText([
      "Fill inside on / offI",
    ]);
  });

  test("every setting's info hint says how to reach and change it", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.keyboard.press("Control+KeyB");
    const tooltip = page.locator(".neuroglancer-fast-tooltip.visible");
    const hintOf = (label: string) =>
      page
        .locator(".neuroglancer-painting-brush-panel label", { hasText: label })
        .locator(".neuroglancer-param-hint");
    // Ctrl+Arrow, or Option+Arrow on a Mac, whichever this browser reports.
    const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
    const modifier = mac ? "⌥" : "Ctrl";
    const chord = (arrow: string) =>
      mac ? `${modifier}${arrow}` : `${modifier}+${arrow}`;
    for (const label of [
      "Target layer",
      "Reference layer",
      "Threshold",
      "Min component",
      "Binary closing",
      "Filter components first",
    ]) {
      await page.mouse.move(0, 0);
      await hintOf(label).first().hover();
      await expect(tooltip).toContainText(
        `Choose it with ${chord("←")} / ${chord("→")}, ` +
          `change it with ${chord("↓")} / ${chord("↑")}.`,
      );
      await expect(tooltip.locator(".neuroglancer-key-chip")).toHaveText([
        modifier,
        "↓",
        modifier,
        "↑",
      ]);
    }
    // A setting with keys of its own keeps them as the caps.
    await page.mouse.move(0, 0);
    await hintOf("Target value").hover();
    const shift = (await page.evaluate(() => /Mac/.test(navigator.platform)))
      ? "⇧"
      : "Shift";
    await expect(tooltip.locator(".neuroglancer-key-chip")).toHaveText([
      shift,
      "[",
      shift,
      "]",
    ]);
    await expect(tooltip).toContainText(`Choose it with ${chord("←")}`);
  });

  test("{ and } step the target value", async () => {
    test.skip(setupError !== undefined, setupError);
    const value = () =>
      page.evaluate(() =>
        String(
          (globalThis as any).viewer.editSessionHost.painting.state.getState()
            .activeValue,
        ),
      );
    await page.keyboard.press("Control+KeyB");
    await expect(page.locator(".neuroglancer-tool-panel-keys")).toBeVisible();
    const before = BigInt(await value());
    await page.keyboard.press("Shift+BracketRight");
    expect(BigInt(await value())).toBe(before + 1n);
    await page.keyboard.press("Shift+BracketLeft");
    expect(BigInt(await value())).toBe(before);
  });

  // The readout shows the colour neuroglancer draws that segment in, so the
  // value about to be painted is recognisable at a glance.
  test("a target value step shows the segment's colour", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.keyboard.press("Control+KeyB");
    await page.keyboard.press("Shift+BracketRight");
    const [expected, activeValue] = await page.evaluate(() => {
      const host = (globalThis as any).viewer.editSessionHost;
      const { targetLayerId, activeValue } = host.painting.state.getState();
      return [
        host.segmentColorFor(targetLayerId, activeValue) as {
          background: string;
          text: string;
        },
        String(activeValue),
      ];
    });
    expect(expected.background).toMatch(/^#[0-9a-f]{6}$/);
    // The whole readout box takes the colour, with text that reads on it.
    const box = page.locator("#neuroglancer-status-container-modal > div");
    await expect(box).toContainText(`Value: ${activeValue}`);
    const shown = await box.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, text: style.color };
    });
    const [red, green, blue] = [1, 3, 5].map((offset) =>
      parseInt(expected.background.slice(offset, offset + 2), 16),
    );
    expect(shown.background).toBe(`rgb(${red}, ${green}, ${blue})`);
    expect(shown.text).toBe(
      expected.text === "white" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
    );
  });

  test("session keys still work after a click on a number field", async () => {
    test.skip(setupError !== undefined, setupError);
    const value = () =>
      page.evaluate(() =>
        String(
          (globalThis as any).viewer.editSessionHost.painting.state.getState()
            .activeValue,
        ),
      );
    await page.keyboard.press("Control+KeyB");
    const sizeField = page
      .locator(".neuroglancer-tool-panel input[type=number]")
      .first();
    await sizeField.click();
    const before = BigInt(await value());
    await page.keyboard.press("Shift+BracketRight");
    expect(BigInt(await value())).toBe(before + 1n);

    // What the field can type stays with it.
    await sizeField.click();
    await sizeField.fill("");
    await page.keyboard.type("9");
    await expect(sizeField).toHaveValue("9");

    await page.keyboard.press("Control+KeyG");
    expect(await activeTool(page)).toBe("painting.fill");
  });

  test("the ? button in the topbar opens the sheet", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await expect(page.locator(".neuroglancer-shortcut-sheet")).toBeVisible();
  });

  // A key changed without a session would not be saved, so the sheet only
  // lists the edit keys then.
  test("the sheet offers no rebinding without a session", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.evaluate(() =>
      (globalThis as any).viewer.editSessionHost.discardActive(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as any).viewer.editSessionHost.activeSession.value ===
            undefined,
        ),
      )
      .toBe(true);
    await focusDataPanel(page);
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    await expect(sheet).toContainText("Open an edit session to change keys.");
    await expect(sheet.locator(".neuroglancer-shortcut-rebind")).toHaveCount(0);
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await expect(
      sheet.locator(".neuroglancer-shortcut-row", { hasText: /^Brush/ }),
    ).toHaveText(mac ? "Brush⌃B" : "BrushCtrlB");
  });

  test("the sheet searches, rebinds and refuses a reserved key", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.keyboard.press("Control+KeyB");
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    await expect(sheet).toContainText("Now: Brush");
    await page.screenshot({ path: test.info().outputPath("sheet.png") });

    // A letter typed into the search is text, not a tool change.
    await page.keyboard.type("fil");
    expect(await activeTool(page)).toBe("painting.brush");
    // "fil" finds both Fill and Fill inside.
    await expect(sheet.locator(".neuroglancer-shortcut-row")).toHaveCount(2);

    await sheet.getByLabel("Change the key for Fill", { exact: true }).click();
    // H opens the sheet, so it is the key a rebind may not take.
    await page.keyboard.press("KeyH");
    await expect(sheet.getByRole("alert")).toContainText(
      'already does "show all shortcuts"',
    );
    await page.keyboard.press("KeyQ");
    await expect(sheet.getByRole("alert")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await focusDataPanel(page);
    await page.keyboard.press("KeyQ");
    expect(await activeTool(page)).toBe("painting.fill");
  });
  // An annotator's own layout may take a viewer key (A is Axis lines): the key
  // is the tool's while the session is open, and the viewer's again after.
  test("a rebind may take a viewer key for the session's duration", async () => {
    test.skip(setupError !== undefined, setupError);
    const axisLines = () =>
      page.evaluate(
        () => (globalThis as any).viewer.showAxisLines.value as boolean,
      );
    const axisLinesBefore = await axisLines();
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    const sheetHeight = async () => (await sheet.boundingBox())!.height;
    const heightBefore = await sheetHeight();
    await sheet
      .getByLabel("Change the key for Cursor", { exact: true })
      .click();
    await page.keyboard.press("KeyA");
    await expect(sheet.getByRole("alert")).toContainText(
      'A no longer does "Axis lines"',
    );
    // The message has a line of its own already: nothing in the sheet moves.
    expect(await sheetHeight()).toBe(heightBefore);
    for (const [label, key] of [
      ["Brush", "KeyS"],
      ["Eraser", "KeyD"],
    ] as const) {
      await sheet
        .getByLabel(`Change the key for ${label}`, { exact: true })
        .click();
      await page.keyboard.press(key);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    await focusDataPanel(page);
    await page.keyboard.press("KeyS");
    expect(await activeTool(page)).toBe("painting.brush");
    await page.keyboard.press("KeyD");
    expect(await activeTool(page)).toBe("painting.erase");
    await page.keyboard.press("KeyA");
    expect(await activeTool(page)).toBeUndefined();
    expect(await axisLines()).toBe(axisLinesBefore);

    await page.evaluate(() =>
      (globalThis as any).viewer.editSessionHost.discardActive(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as any).viewer.editSessionHost.activeSession.value ===
            undefined,
        ),
      )
      .toBe(true);
    await focusDataPanel(page);
    await page.keyboard.press("KeyA");
    // One press; waited for, since the panels are still settling after the
    // session's teardown.
    await expect.poll(axisLines).toBe(!axisLinesBefore);
  });
  // Keys belong to the annotator's browser: not in the viewer state (a shared
  // link must not carry them), kept across a reload, and followed by the
  // site's other tabs.
  test("rebound keys live in this browser, not in the shared state", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    await sheet.getByLabel("Change the key for Brush", { exact: true }).click();
    await page.keyboard.press("KeyS");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    const stored = () =>
      page.evaluate(() => localStorage.getItem("zetta-edit-keybinds"));
    await expect.poll(stored).toBe(JSON.stringify({ brush: ["keys"] }));
    // Change the brush size so the tooling block is written again (it is on a
    // debounce), wait until the state holds the new size, then look for keys.
    await focusDataPanel(page);
    await page.keyboard.press("KeyS");
    expect(await activeTool(page)).toBe("painting.brush");
    await page.keyboard.press("Shift+Equal");
    const radiusNow = await page.evaluate(
      () =>
        (
          globalThis as any
        ).viewer.editSessionHost.paintingTools.state.getState()
          .radius as number,
    );
    const persistedRadius = () =>
      page.evaluate(
        () =>
          (globalThis as any).viewer.state.toJSON().editSession?.tooling
            ?.painting?.radius,
      );
    await expect.poll(persistedRadius).toBe(radiusNow);
    const stateText = await page.evaluate(() =>
      JSON.stringify((globalThis as any).viewer.state.toJSON()),
    );
    expect(stateText).not.toContain("keybinds");

    const other = await page.context().newPage();
    await other.goto(page.url());
    const otherOverrides = () =>
      other.evaluate(
        () =>
          (globalThis as any).viewer?.editSessionHost.editKeybindOverrides
            .value,
      );
    await expect.poll(otherOverrides).toEqual({ brush: ["keys"] });

    await page.evaluate(() =>
      (globalThis as any).viewer.editSessionHost.setEditKeybind("brush", [
        "keyw",
      ]),
    );
    await expect.poll(otherOverrides).toEqual({ brush: ["keyw"] });
  });
  // Taking another edit action's key swaps the two instead of refusing, so a
  // layout can be rearranged without first freeing keys up.
  test("taking another tool's key swaps the two", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    await sheet.getByLabel("Change the key for Fill", { exact: true }).click();
    await page.keyboard.press("Control+KeyB");
    await expect(sheet.getByRole("alert")).toContainText(
      "Brush took Fill's old key",
    );
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    await focusDataPanel(page);
    await page.keyboard.press("Control+KeyB");
    expect(await activeTool(page)).toBe("painting.fill");
    await page.keyboard.press("Control+KeyG");
    expect(await activeTool(page)).toBe("painting.brush");
  });

  // Plain [ / ] are viewer keys like A: a rebind may take them, with the note.
  test("a rebind may take [ with the same note", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    await sheet
      .getByLabel("Change the key for Cursor", { exact: true })
      .click();
    await page.keyboard.press("BracketLeft");
    await expect(sheet.getByRole("alert")).toContainText(
      '[ no longer does "Previous selected segment"',
    );
    await page.keyboard.press("Escape");
    await focusDataPanel(page);
    await page.keyboard.press("Control+KeyB");
    expect(await activeTool(page)).toBe("painting.brush");
    await page.keyboard.press("BracketLeft");
    expect(await activeTool(page)).toBeUndefined();
  });
  // The sheet lists every key of an action, so a key a rebind took visibly
  // goes and the note names what is left (− taken from Smaller brush).
  test("the sheet shows every key, and what a taken key leaves", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    const smallerBrush = sheet
      .locator(".neuroglancer-shortcut-columns .neuroglancer-shortcut-row")
      .filter({ hasText: /^Smaller brush/ });
    await expect(smallerBrush.locator(".neuroglancer-key-chip")).toHaveText([
      "−",
      "Num−",
    ]);

    await sheet
      .getByLabel("Change the key for Cursor", { exact: true })
      .click();
    await page.keyboard.press("Minus");
    await expect(sheet.getByRole("alert")).toContainText(
      "Smaller brush no longer uses −; it still works with Num−.",
    );
    await expect(smallerBrush.locator(".neuroglancer-key-chip")).toHaveText([
      "Num−",
    ]);
  });
  // Every tool, rebound to a plain letter from the sheet, is reached by it with
  // a data panel focused — whatever that letter did in the viewer before.
  test("every tool works from the key it was rebound to", async () => {
    test.skip(setupError !== undefined, setupError);
    const layout = [
      ["Brush", "KeyQ", "painting.brush"],
      ["Eraser", "KeyW", "painting.erase"],
      ["Fill", "KeyY", "painting.fill"],
      ["Z-extrapolation", "KeyJ", "z-extrapolation"],
      ["Cursor", "KeyK", undefined],
    ] as const;
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    for (const [label, key] of layout) {
      await sheet
        .getByLabel(`Change the key for ${label}`, { exact: true })
        .click();
      await page.keyboard.press(key);
      await expect(
        sheet.locator(".neuroglancer-shortcut-rebind.capturing"),
      ).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await focusDataPanel(page);
    for (const [label, key, toolId] of layout) {
      await page.keyboard.press(key);
      expect(await activeTool(page), `${label} on ${key}`).toBe(toolId);
    }
    // The old Ctrl keys went with the rebind.
    await page.keyboard.press("Control+KeyB");
    expect(await activeTool(page)).toBeUndefined();
  });
  // The same with the 3D panel focused: the session's keys come before the
  // perspective panel's own (and the viewer's) for A / S / D and [.
  test("rebound keys work with the 3D panel focused", async () => {
    test.skip(setupError !== undefined, setupError);
    await page.evaluate(() =>
      (globalThis as any).viewer.layout.restoreState("3d"),
    );
    await expect
      .poll(() =>
        page.evaluate(() => ({
          layout: (globalThis as any).viewer.layout.toJSON(),
          panels: document.querySelectorAll(".neuroglancer-rendered-data-panel")
            .length,
        })),
      )
      .toEqual({ layout: "3d", panels: 1 });
    const axisLines = () =>
      page.evaluate(
        () => (globalThis as any).viewer.showAxisLines.value as boolean,
      );
    const showSlices = () =>
      page.evaluate(
        () =>
          (globalThis as any).viewer.showPerspectiveSliceViews.value as boolean,
      );
    const axisLinesBefore = await axisLines();
    const showSlicesBefore = await showSlices();

    await focusDataPanel(page);
    await page.keyboard.press("KeyH");
    const sheet = page.locator(".neuroglancer-shortcut-sheet");
    for (const [label, key] of [
      ["Cursor", "KeyA"],
      ["Brush", "KeyS"],
      ["Eraser", "KeyD"],
      ["Fill", "BracketLeft"],
    ] as const) {
      await sheet
        .getByLabel(`Change the key for ${label}`, { exact: true })
        .click();
      await page.keyboard.press(key);
      await expect(
        sheet.locator(".neuroglancer-shortcut-rebind.capturing"),
      ).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    await focusDataPanel(page);
    expect(
      await page.evaluate(() =>
        document.activeElement?.classList.contains(
          "neuroglancer-rendered-data-panel",
        ),
      ),
    ).toBe(true);
    await page.keyboard.press("KeyS");
    expect(await activeTool(page)).toBe("painting.brush");
    await page.keyboard.press("KeyD");
    expect(await activeTool(page)).toBe("painting.erase");
    await page.keyboard.press("BracketLeft");
    expect(await activeTool(page)).toBe("painting.fill");
    await page.keyboard.press("KeyA");
    expect(await activeTool(page)).toBeUndefined();
    // None of them reached the viewer's own actions on the way.
    expect(await axisLines()).toBe(axisLinesBefore);
    expect(await showSlices()).toBe(showSlicesBefore);
  });
});
