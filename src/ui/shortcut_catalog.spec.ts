/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import type { EditKeybindName } from "#src/editing/session_hotkey_binder.js";
import { effectiveEditKeybinds } from "#src/editing/session_hotkey_binder.js";
import {
  buildShortcutSections,
  filterShortcutSections,
} from "#src/ui/shortcut_catalog.js";
import { EventActionMap } from "#src/util/event_action_map.js";

const editKeys: Record<EditKeybindName, readonly string[]> =
  effectiveEditKeybinds(undefined);

describe("buildShortcutSections", () => {
  const map = EventActionMap.fromObject({ space: "toggle-layout" });
  const sections = buildShortcutSections(editKeys, [map], false);
  const section = (title: string) =>
    sections.find((candidate) => candidate.title === title)!;

  it("reads edit keys from what the session binds and marks them rebindable", () => {
    const brush = section("Edit session").rows.find(
      (row) => row.label === "Brush",
    )!;
    expect(brush.keys).toEqual(editKeys.brush);
    expect(brush.rebind).toBe("brush");
  });

  it("reads view keys from the input maps and leaves out unbound actions", () => {
    expect(section("View").rows).toEqual([
      { label: "Switch layout", keys: ["space"] },
    ]);
  });
});

describe("buildShortcutSections during a session", () => {
  const map = EventActionMap.fromObject({
    keyb: "toggle-scale-bar",
    space: "toggle-layout",
  });
  const viewRows = (sessionActive: boolean) =>
    buildShortcutSections(editKeys, [map], sessionActive)
      .find((section) => section.title === "View")!
      .rows.map((row) => row.label);

  it("hides a view key the session has taken, and only then", () => {
    expect(viewRows(false)).toEqual(["Switch layout", "Scale bar"]);
    expect(viewRows(true)).toEqual(["Switch layout"]);
  });
});

describe("filterShortcutSections", () => {
  const sections = [
    { title: "A", rows: [{ label: "Brush", keys: ["keyb"] }] },
    { title: "B", rows: [{ label: "Undo", keys: ["control+keyz"] }] },
  ];

  it("keeps matching rows whatever the case and drops empty sections", () => {
    expect(filterShortcutSections(sections, " BRU ")).toEqual([sections[0]]);
  });

  it("returns everything for an empty query", () => {
    expect(filterShortcutSections(sections, "  ")).toEqual(sections);
  });
});

describe("buildShortcutSections entry keys", () => {
  const editRows = (sessionActive: boolean) =>
    buildShortcutSections(editKeys, [], sessionActive)
      .find((section) => section.title === "Edit session")!
      .rows.slice(0, 2);

  it("lists the keys that open a session only while none is active", () => {
    expect(editRows(false)).toEqual([
      // Ctrl even on a Mac: Cmd+E is often claimed before the page sees it.
      { label: "Open edit session", keys: ["control+keye"] },
      { label: "Draw an edit region", keys: ["control+shift+keye"] },
    ]);
    // Inside a session Ctrl+E is the eraser, so the sheet starts at Cursor.
    expect(editRows(true).map((row) => row.label)).toEqual(["Cursor", "Brush"]);
  });
});
