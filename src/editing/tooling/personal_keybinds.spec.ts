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
  parseKeybindOverrides,
  PERSONAL_KEYBINDS_STORAGE_KEY,
  readPersonalKeybinds,
  sameKeybindOverrides,
  writePersonalKeybinds,
  type KeybindStorage,
} from "#src/editing/tooling/personal_keybinds.js";

function fakeStorage(): KeybindStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

const throwingStorage: KeybindStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("personal keybinds in browser storage", () => {
  it("round-trips the overrides", () => {
    const storage = fakeStorage();
    writePersonalKeybinds(
      { cursor: ["keya"], brush: ["keys"], erase: ["keyd"] },
      storage,
    );
    expect(readPersonalKeybinds(storage)).toEqual({
      cursor: ["keya"],
      brush: ["keys"],
      erase: ["keyd"],
    });
  });

  it("removes the entry when every key is back to its default", () => {
    const storage = fakeStorage();
    writePersonalKeybinds({ brush: ["keys"] }, storage);
    writePersonalKeybinds({}, storage);
    expect(storage.entries.has(PERSONAL_KEYBINDS_STORAGE_KEY)).toBe(false);
    expect(readPersonalKeybinds(storage)).toEqual({});
  });

  it("reads nothing stored, broken JSON or no storage as the defaults", () => {
    const storage = fakeStorage();
    expect(readPersonalKeybinds(storage)).toEqual({});
    storage.setItem(PERSONAL_KEYBINDS_STORAGE_KEY, "{not json");
    expect(readPersonalKeybinds(storage)).toEqual({});
    expect(readPersonalKeybinds(undefined)).toEqual({});
  });

  it("survives storage that throws", () => {
    expect(readPersonalKeybinds(throwingStorage)).toEqual({});
    expect(() =>
      writePersonalKeybinds({ brush: ["keys"] }, throwingStorage),
    ).not.toThrow();
  });
});

describe("parseKeybindOverrides", () => {
  it("coerces a single-string value to a one-element array", () => {
    expect(parseKeybindOverrides({ brush: "control+keyq" })).toEqual({
      brush: ["control+keyq"],
    });
  });

  it("skips malformed entries but keeps the valid ones", () => {
    expect(
      parseKeybindOverrides({
        brush: ["control+keyq"],
        bad: 42,
        empty: [],
        mixed: ["keya", 7, "keyb"],
      }),
    ).toEqual({
      brush: ["control+keyq"],
      mixed: ["keya", "keyb"],
    });
  });

  it("reads a non-object as no overrides", () => {
    expect(parseKeybindOverrides(42)).toEqual({});
    expect(parseKeybindOverrides(["keya"])).toEqual({});
    expect(parseKeybindOverrides(null)).toEqual({});
  });
});

describe("sameKeybindOverrides", () => {
  it("compares names and key lists, in order", () => {
    expect(sameKeybindOverrides({ brush: ["keys"] }, { brush: ["keys"] })).toBe(
      true,
    );
    expect(sameKeybindOverrides({ brush: ["keys"] }, { brush: ["keyd"] })).toBe(
      false,
    );
    expect(sameKeybindOverrides({ brush: ["keys"] }, { erase: ["keys"] })).toBe(
      false,
    );
    expect(
      sameKeybindOverrides({ brush: ["keys"] }, { brush: ["keys", "keyd"] }),
    ).toBe(false);
    expect(sameKeybindOverrides({}, {})).toBe(true);
  });
});
