/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import {
  EDIT_KEYBIND_NAMES,
  editModeShortcuts,
  effectiveEditKeybinds,
  findEditKeybindConflict,
  isMacPlatform,
  mergeEditKeybinds,
  paramArrowDefaults,
} from "#src/editing/session_hotkey_binder.js";
import { EventActionMap } from "#src/util/event_action_map.js";

const A = {
  brush: "edit-session-tool-brush",
  erase: "edit-session-tool-erase",
  fill: "edit-session-tool-fill",
  zextrap: "edit-session-tool-zextrap",
  cursor: "edit-session-cursor-mode",
  undo: "edit-session-undo",
  redo: "edit-session-redo",
  sizeDecr: "edit-session-size-decr",
  sizeIncr: "edit-session-size-incr",
  paramPrev: "edit-session-param-prev",
  paramNext: "edit-session-param-next",
  paramIncr: "edit-session-param-incr",
  paramDecr: "edit-session-param-decr",
  exit: "edit-session-exit-tool",
} as const;

describe("mergeEditKeybinds", () => {
  it("uses built-in defaults when there are no overrides", () => {
    const m = mergeEditKeybinds(undefined);
    // Tools take Ctrl: plain letters stay neuroglancer's (E / R rotate the
    // view, B the scale bar, V the default annotations).
    expect(m["control+keyb"]).toBe(A.brush);
    expect(m["control+keye"]).toBe(A.erase);
    expect(m["control+keyg"]).toBe(A.fill);
    expect(m["control+keyv"]).toBe(A.cursor);
    expect(m["control+keyx"]).toBe(A.zextrap);
    for (const letter of [
      "keyb",
      "keye",
      "keyr",
      "keyg",
      "keyv",
      "keyx",
      "keyz",
    ]) {
      expect(m[letter]).toBeUndefined();
    }
    // Ctrl+F is the browser's Find.
    expect(m["control+keyf"]).toBeUndefined();
    expect(m["keyf"]).toBeUndefined();
    // Multi-key defaults (undo/redo + size) all map to their action.
    expect(m["control+keyz"]).toBe(A.undo);
    expect(m["meta+keyz"]).toBe(A.undo);
    expect(m["minus"]).toBe(A.sizeDecr);
    expect(m["numpadsubtract"]).toBe(A.sizeDecr);
    // `[` / `]` are intentionally NOT bound by the session layer, so they fall
    // through to the global `select-previous` / `select-next` annotation
    // navigation while a session is active (TM-439).
    expect(m["bracketleft"]).toBeUndefined();
    expect(m["bracketright"]).toBeUndefined();
    expect(m["shift+bracketleft"]).toBe("edit-session-target-value-decr");
    expect(m["shift+bracketright"]).toBe("edit-session-target-value-incr");
    expect(m["keyi"]).toBe("edit-session-toggle-fill-closed-paths");
    // Ctrl+Arrow parameter scheme (TM-337), per-platform default keys.
    const arrows = paramArrowDefaults(isMacPlatform());
    expect(m[arrows.paramPrev[0]]).toBe(A.paramPrev);
    expect(m[arrows.paramNext[0]]).toBe(A.paramNext);
    expect(m[arrows.paramIncrease[0]]).toBe(A.paramIncr);
    expect(m[arrows.paramDecrease[0]]).toBe(A.paramDecr);
  });

  it("always includes the fixed (non-configurable) bindings", () => {
    const m = mergeEditKeybinds({ brush: "control+keyq" });
    expect(m["escape"]).toBe(A.exit);
    // `keyl` / `keyh` are no longer shadowed (the L/H threshold chord was
    // removed in TM-439), so global recolor/help stay live during a session.
    expect(m["keyl"]).toBeUndefined();
    expect(m["keyh"]).toBeUndefined();
  });

  it("a single-key override replaces the default for that action", () => {
    const m = mergeEditKeybinds({ brush: "control+keyq" });
    expect(m["control+keyq"]).toBe(A.brush);
    // The old default key is no longer bound to brush.
    expect(m["control+keyb"]).toBeUndefined();
    // Other actions keep their defaults.
    expect(m["control+keye"]).toBe(A.erase);
  });

  it("an array override binds every listed key", () => {
    const m = mergeEditKeybinds({ undo: ["control+keyu", "keyz"] });
    expect(m["control+keyu"]).toBe(A.undo);
    expect(m["keyz"]).toBe(A.undo);
    expect(m["control+keyz"]).toBeUndefined(); // default replaced
  });

  it("ignores unknown override names", () => {
    const m = mergeEditKeybinds({ nonsense: "control+keyq" } as never);
    expect(m["control+keyq"]).toBeUndefined();
    expect(m["control+keyb"]).toBe(A.brush); // defaults intact
  });
});

describe("paramArrowDefaults", () => {
  it("uses Ctrl+Arrow on non-mac platforms", () => {
    const d = paramArrowDefaults(false);
    expect(d.paramPrev).toEqual(["control+arrowleft"]);
    expect(d.paramNext).toEqual(["control+arrowright"]);
    expect(d.paramIncrease).toEqual(["control+arrowup"]);
    expect(d.paramDecrease).toEqual(["control+arrowdown"]);
  });

  it("uses Option/Alt+Arrow on macOS (Ctrl+Arrow is reserved by Spaces)", () => {
    const d = paramArrowDefaults(true);
    expect(d.paramPrev).toEqual(["alt+arrowleft"]);
    expect(d.paramNext).toEqual(["alt+arrowright"]);
    expect(d.paramIncrease).toEqual(["alt+arrowup"]);
    expect(d.paramDecrease).toEqual(["alt+arrowdown"]);
  });
});

describe("effectiveEditKeybinds", () => {
  it("returns the built-in defaults when there are no overrides", () => {
    // No `custom-keybinds.json` is injected in the test build, so the result
    // is exactly the built-in defaults.
    const e = effectiveEditKeybinds(undefined);
    expect(e.brush).toEqual(["control+keyb"]);
    expect(e.undo).toEqual(["control+keyz", "meta+keyz"]);
    expect(e.sizeDecrease).toEqual(["minus", "numpadsubtract"]);
  });

  it("applies a per-user override (whole list replace) for one action", () => {
    const e = effectiveEditKeybinds({ brush: ["control+keyq"] });
    expect(e.brush).toEqual(["control+keyq"]);
    // Other actions keep their defaults.
    expect(e.erase).toEqual(["control+keye"]);
  });

  it("covers every configurable action name", () => {
    const e = effectiveEditKeybinds(undefined);
    for (const name of EDIT_KEYBIND_NAMES) {
      expect(Array.isArray(e[name])).toBe(true);
      expect(e[name].length).toBeGreaterThan(0);
    }
  });

  it("stays in lock-step with the action map the binder installs", () => {
    // Every key the effective map advertises for an action must route to that
    // action's id in the binder's actual key→action map.
    const overrides = { brush: ["control+keyq"], fill: ["keyg"] };
    const effective = effectiveEditKeybinds(overrides);
    const keyToAction = mergeEditKeybinds(overrides);
    const NAME_TO_ACTION: Record<string, string> = {
      brush: A.brush,
      erase: A.erase,
      fill: A.fill,
      zextrap: A.zextrap,
      cursor: A.cursor,
      undo: A.undo,
      redo: A.redo,
      saveAll: "edit-session-save-all",
      targetValueDecrease: "edit-session-target-value-decr",
      targetValueIncrease: "edit-session-target-value-incr",
      fillClosedPaths: "edit-session-toggle-fill-closed-paths",
      sizeDecrease: A.sizeDecr,
      sizeIncrease: A.sizeIncr,
      paramPrev: A.paramPrev,
      paramNext: A.paramNext,
      paramIncrease: A.paramIncr,
      paramDecrease: A.paramDecr,
    };
    for (const name of EDIT_KEYBIND_NAMES) {
      for (const key of effective[name]) {
        expect(keyToAction[key]).toBe(NAME_TO_ACTION[name]);
      }
    }
  });
});

describe("findEditKeybindConflict", () => {
  const effective = effectiveEditKeybinds(undefined);

  it("names the action that already has the key", () => {
    expect(findEditKeybindConflict("fill", "control+keyb", effective)).toBe(
      "brush",
    );
    expect(findEditKeybindConflict("brush", "control+keyz", effective)).toBe(
      "undo",
    );
  });

  it("lets an action keep its own key and take a free one", () => {
    expect(
      findEditKeybindConflict("brush", "control+keyb", effective),
    ).toBeUndefined();
    expect(findEditKeybindConflict("brush", "keyq", effective)).toBeUndefined();
  });

  it("refuses Esc, which is fixed", () => {
    expect(findEditKeybindConflict("brush", "escape", effective)).toBe("exit");
  });

  it("refuses H and the annotation keys of TM-439", () => {
    expect(findEditKeybindConflict("brush", "keyh", effective)).toBe(
      "show all shortcuts",
    );
    expect(findEditKeybindConflict("brush", "bracketleft", effective)).toBe(
      "previous annotation",
    );
  });

  it("refuses a key the viewer binds, but not one the session itself binds", () => {
    const viewerMap = EventActionMap.fromObject({
      keyt: "calcada-toggle-zetta-trace",
    });
    viewerMap.addParent(
      EventActionMap.fromObject({ keyq: "edit-session-tool-brush" }),
      100,
    );
    expect(
      findEditKeybindConflict("fill", "keyt", effective, [viewerMap]),
    ).toBe("calcada-toggle-zetta-trace");
    expect(
      findEditKeybindConflict("fill", "keyq", effective, [viewerMap]),
    ).toBeUndefined();
  });
});

describe("editModeShortcuts", () => {
  const keys = effectiveEditKeybinds(undefined);
  const labels = (toolId: string) =>
    editModeShortcuts(toolId, keys).map((shortcut) => shortcut.label);

  it("offers each tool only the keys that apply to it", () => {
    expect(labels("painting.brush")).toEqual([
      "Size",
      "Fill inside",
      "Target value",
      "Choose setting",
      "Change setting",
      "Undo",
      "Redo",
      "Save all",
      "Cursor",
    ]);
    expect(labels("painting.fill")).toEqual([
      "Target value",
      "Choose setting",
      "Change setting",
      "Undo",
      "Redo",
      "Save all",
      "Cursor",
    ]);
    expect(labels("z-extrapolation")).toEqual([
      "Undo",
      "Redo",
      "Save all",
      "Cursor",
    ]);
  });

  it("shows the tools themselves on the plain cursor", () => {
    expect(
      editModeShortcuts(undefined, keys).map((shortcut) => shortcut.label),
    ).toEqual([
      "Brush",
      "Eraser",
      "Fill",
      "Z-extrapolation",
      "Undo",
      "Redo",
      "Save all",
    ]);
  });

  it("pairs the two size keys", () => {
    const size = editModeShortcuts("painting.brush", keys)[0];
    expect(size.keys).toEqual(keys.sizeDecrease);
    expect(size.pairKeys).toEqual(keys.sizeIncrease);
  });

  it("follows a rebound key", () => {
    const rebound = effectiveEditKeybinds({ undo: ["keyq"] });
    const undo = editModeShortcuts("painting.brush", rebound).find(
      (shortcut) => shortcut.label === "Undo",
    );
    expect(undo?.keys).toEqual(["keyq"]);
  });
});
