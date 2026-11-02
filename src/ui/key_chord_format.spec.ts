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

import {
  ariaKeyShortcuts,
  chordKeyLabels,
  chordsForAction,
  formatChord,
  formatShortcutKeys,
  preferredChord,
  shortcutAttributes,
} from "#src/ui/key_chord_format.js";
import { EventActionMap } from "#src/util/event_action_map.js";

describe("chordKeyLabels", () => {
  it("names modifiers per platform and keeps macOS modifier order", () => {
    expect(chordKeyLabels("control+shift+keyz", false)).toEqual([
      "Ctrl",
      "Shift",
      "Z",
    ]);
    expect(chordKeyLabels("meta+shift+keyz", true)).toEqual(["⇧", "⌘", "Z"]);
    expect(chordKeyLabels("alt+arrowleft", true)).toEqual(["⌥", "←"]);
  });

  it("shows shifted punctuation as the character it types", () => {
    expect(chordKeyLabels("shift+slash", false)).toEqual(["?"]);
    expect(chordKeyLabels("shift+equal", true)).toEqual(["+"]);
  });

  it("drops input phases and optional modifiers", () => {
    expect(chordKeyLabels("at:arrowright", false)).toEqual(["→"]);
    expect(chordKeyLabels("at:shift?+keyg", false)).toEqual(["G"]);
  });

  it("names mouse chords", () => {
    expect(chordKeyLabels("control+mousedown0", false)).toEqual([
      "Ctrl",
      "click",
    ]);
  });
});

describe("formatChord", () => {
  it("joins with + except on a Mac", () => {
    expect(formatChord("control+keyb", false)).toBe("Ctrl+B");
    expect(formatChord("meta+shift+keyz", true)).toBe("⇧⌘Z");
  });
});

describe("formatShortcutKeys", () => {
  it("joins a pair and leaves out what this platform cannot use", () => {
    expect(formatShortcutKeys(["minus"], ["shift+equal"])).toBe("− / +");
    expect(formatShortcutKeys(["keyt"])).toBe("T");
    expect(formatShortcutKeys([])).toBe("");
  });
});

describe("preferredChord", () => {
  const undo = ["control+keyz", "meta+keyz"];

  it("shows the Cmd twin on a Mac and never a Cmd chord elsewhere", () => {
    expect(preferredChord(undo, true)).toBe("meta+keyz");
    expect(preferredChord(undo, false)).toBe("control+keyz");
    expect(preferredChord(["meta+keyz"], false)).toBeUndefined();
  });

  it("keeps a Ctrl chord that has no Cmd twin", () => {
    expect(preferredChord(["control+arrowup"], true)).toBe("control+arrowup");
  });

  it("takes the first when the action has a plain key and a legacy chord", () => {
    expect(preferredChord(["keyb", "control+keyb"], true)).toBe("keyb");
    expect(preferredChord(["keyb", "control+keyb"], false)).toBe("keyb");
  });
});

describe("ariaKeyShortcuts", () => {
  it("uses ARIA key names and leaves out mouse chords", () => {
    expect(ariaKeyShortcuts(["arrowright"])).toBe("ArrowRight");
    expect(ariaKeyShortcuts(["control+keyz", "meta+keyz"])).toBe(
      "Control+Z Meta+Z",
    );
    expect(ariaKeyShortcuts(["control+mousedown0"])).toBe("");
  });
});

describe("shortcutAttributes", () => {
  it("names both halves of a pair for the tooltip and assistive tech", () => {
    expect(shortcutAttributes(["minus"], ["shift+equal"])).toEqual({
      "data-shortcut": "minus",
      "data-shortcut-pair": "shift+equal",
      "aria-keyshortcuts": "- Shift+=",
    });
    expect(shortcutAttributes(["keyi"])).toEqual({
      "data-shortcut": "keyi",
      "aria-keyshortcuts": "I",
    });
  });
});

describe("chordsForAction", () => {
  it("reads every chord an input map binds, without its phase", () => {
    const map = EventActionMap.fromObject({
      "at:control+keyz": { action: "undo" },
      "at:meta+keyz": { action: "undo" },
      "at:arrowright": { action: "accept" },
    });
    expect(chordsForAction(map, "undo")).toEqual(["control+keyz", "meta+keyz"]);
    expect(chordsForAction(map, "missing")).toEqual([]);
  });
});
