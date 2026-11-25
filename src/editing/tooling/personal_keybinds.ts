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
 * @file The annotator's own edit-hotkey layout, kept in this browser
 * (localStorage) and not in the viewer state: a shared link must not carry one
 * person's keys to another. Every tab of the same site shares it, and a change
 * in one tab reaches the others through the `storage` event.
 */

/** Per-user edit-hotkey overrides: friendly action name → key identifier(s). */
export type EditKeybindOverrides = {
  readonly [name: string]: readonly string[];
};

export const PERSONAL_KEYBINDS_STORAGE_KEY = "zetta-edit-keybinds";

/** The part of `Storage` this file uses, so tests can pass a plain fake. */
export type KeybindStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function browserStorage(): KeybindStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // Blocked storage (privacy settings, sandboxed frame) throws on access.
    return undefined;
  }
}

/**
 * Parse stored overrides. Tolerant: skips any malformed entry (non-string keys
 * list) rather than dropping them all; a bare string is a one-key list.
 */
export function parseKeybindOverrides(value: unknown): EditKeybindOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const overrides: { [name: string]: readonly string[] } = {};
  for (const [name, raw] of Object.entries(value)) {
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : typeof raw === "string"
        ? [raw]
        : [];
    if (keys.length > 0) overrides[name] = keys;
  }
  return overrides;
}

function parseStoredText(text: string | null): EditKeybindOverrides {
  if (text === null) return {};
  try {
    return parseKeybindOverrides(JSON.parse(text));
  } catch {
    return {};
  }
}

/** This browser's overrides; `{}` (the configured defaults) when none. */
export function readPersonalKeybinds(
  storage: KeybindStorage | undefined = browserStorage(),
): EditKeybindOverrides {
  try {
    return parseStoredText(
      storage?.getItem(PERSONAL_KEYBINDS_STORAGE_KEY) ?? null,
    );
  } catch {
    return {};
  }
}

/** Save the overrides; an empty set removes the entry. */
export function writePersonalKeybinds(
  overrides: EditKeybindOverrides,
  storage: KeybindStorage | undefined = browserStorage(),
): void {
  try {
    if (Object.keys(overrides).length === 0) {
      storage?.removeItem(PERSONAL_KEYBINDS_STORAGE_KEY);
    } else {
      storage?.setItem(
        PERSONAL_KEYBINDS_STORAGE_KEY,
        JSON.stringify(overrides),
      );
    }
  } catch {
    // Unavailable or full storage only means the layout lasts for this page.
  }
}

/** Whether two override sets bind the same keys to the same actions. */
export function sameKeybindOverrides(
  first: EditKeybindOverrides,
  second: EditKeybindOverrides,
): boolean {
  const names = Object.keys(first);
  if (names.length !== Object.keys(second).length) return false;
  return names.every((name) => {
    const firstKeys = first[name];
    const secondKeys = second[name];
    return (
      secondKeys !== undefined &&
      firstKeys.length === secondKeys.length &&
      firstKeys.every((key, i) => key === secondKeys[i])
    );
  });
}

/**
 * Call `onChange` with the new overrides when another tab saves them. Returns
 * the function that stops listening.
 */
export function watchPersonalKeybinds(
  onChange: (overrides: EditKeybindOverrides) => void,
): () => void {
  const onStorage = (event: StorageEvent) => {
    // `key` is null when another tab cleared all of this site's storage.
    if (event.key !== PERSONAL_KEYBINDS_STORAGE_KEY && event.key !== null) {
      return;
    }
    onChange(parseStoredText(event.newValue));
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => globalThis.removeEventListener?.("storage", onStorage);
}
