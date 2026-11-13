/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { modeShortcuts } from "#src/ui/mode_shortcuts.js";
import { ModeShortcutStrip, modeStripHidden } from "#src/ui/shortcut_help.js";

let anchor: HTMLDivElement;
let withdraw: () => void;

beforeEach(() => {
  modeStripHidden.value = false;
  withdraw = modeShortcuts.publish({
    id: "test-trace",
    title: "Trace",
    priority: 1,
    shortcuts: [{ keys: ["arrowright"], label: "Accept" }],
  });
  anchor = document.body.appendChild(document.createElement("div"));
  act(() => {
    render(h(ModeShortcutStrip, {}), anchor);
  });
});

afterEach(() => {
  act(() => {
    render(null, anchor);
  });
  anchor.remove();
  withdraw();
  modeStripHidden.value = false;
});

const button = (selector: string) =>
  anchor.querySelector<HTMLButtonElement>(selector);

describe("ModeShortcutStrip", () => {
  it("collapses to a button that brings the keys back", () => {
    expect(anchor.textContent).toContain("Accept");

    act(() => button(".neuroglancer-mode-strip-close")!.click());
    expect(anchor.textContent).not.toContain("Accept");
    const expand = button(".neuroglancer-mode-strip-expand");
    expect(expand?.textContent).toContain("Trace");

    act(() => expand!.click());
    expect(anchor.textContent).toContain("Accept");
    expect(modeStripHidden.value).toBe(false);
  });
});
