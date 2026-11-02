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
 * One way to show a keyboard chord to a person, used by tooltips, buttons, the
 * mode strip and the shortcut sheet. Everything takes neuroglancer event
 * identifiers (`"control+shift+keyz"`), the same strings the input maps hold, so
 * what is displayed cannot drift from what the key does.
 */

import type { EventActionMap } from "#src/util/event_action_map.js";

/** True when running on macOS (best-effort; false in non-browser contexts). */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  const userAgent = navigator.userAgent ?? "";
  return /mac/i.test(platform) || /mac os x/i.test(userAgent);
}

const PHASE_PREFIX = /^(?:at|bubble|capture):/;

const MAC_MODIFIER_ORDER = ["control", "alt", "shift", "meta"] as const;
const WINDOWS_MODIFIER_ORDER = ["control", "meta", "shift", "alt"] as const;
type ModifierName = (typeof MAC_MODIFIER_ORDER)[number];

const WINDOWS_MODIFIER_LABEL: Record<ModifierName, string> = {
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Cmd",
};

const MAC_MODIFIER_LABEL: Record<ModifierName, string> = {
  control: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
};

const KEY_LABEL: Record<string, string> = {
  // A true minus sign: on a key cap a hyphen is too small to read.
  minus: "−",
  equal: "=",
  bracketleft: "[",
  bracketright: "]",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  escape: "Esc",
  add: "+",
  subtract: "−",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  mousedown0: "click",
  mousedown2: "right-click",
  wheel: "wheel",
};

// Shifted punctuation is shown as the character it types.
const SHIFTED_KEY_LABEL: Record<string, string> = {
  slash: "?",
  equal: "+",
  bracketleft: "{",
  bracketright: "}",
};

function formatKeyName(key: string): string {
  const letter = /^key([a-z])$/.exec(key);
  if (letter !== null) return letter[1].toUpperCase();
  const digit = /^digit([0-9])$/.exec(key);
  if (digit !== null) return digit[1];
  const numpad = /^numpad(.+)$/.exec(key);
  if (numpad !== null) return `Num${formatKeyName(numpad[1])}`;
  const label = KEY_LABEL[key];
  if (label !== undefined) return label;
  return key.length > 0 ? key[0].toUpperCase() + key.slice(1) : key;
}

function isModifierName(part: string): part is ModifierName {
  return (MAC_MODIFIER_ORDER as readonly string[]).includes(part);
}

/**
 * The separate key caps of a chord, modifiers first:
 * `"control+shift+keyz"` → `["Ctrl", "Shift", "Z"]`, or `["⌃", "⇧", "Z"]` on a
 * Mac. Input map phases and optional modifiers (`shift?+`) are not shown.
 */
export function chordKeyLabels(
  identifier: string,
  mac: boolean = isMacPlatform(),
): string[] {
  const parts = identifier
    .replace(PHASE_PREFIX, "")
    .split("+")
    .filter((part) => !part.endsWith("?"));
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).filter(isModifierName);
  const shiftedLabel = modifiers.includes("shift")
    ? SHIFTED_KEY_LABEL[key]
    : undefined;
  const modifierLabel = mac ? MAC_MODIFIER_LABEL : WINDOWS_MODIFIER_LABEL;
  const modifierOrder = mac ? MAC_MODIFIER_ORDER : WINDOWS_MODIFIER_ORDER;
  const labels = modifierOrder
    .filter(
      (name) =>
        modifiers.includes(name) &&
        !(name === "shift" && shiftedLabel !== undefined),
    )
    .map((name) => modifierLabel[name]);
  labels.push(shiftedLabel ?? formatKeyName(key));
  return labels;
}

/** A chord as one string: `"Ctrl+Shift+Z"`, or `"⌃⇧Z"` on a Mac. */
export function formatChord(
  identifier: string,
  mac: boolean = isMacPlatform(),
): string {
  return chordKeyLabels(identifier, mac).join(mac ? "" : "+");
}

/**
 * The text of a Hotkeys row: `"⌘Z"`, or both halves of a pair as `"− / +"`. Empty
 * when this platform has no usable chord for it.
 */
export function formatShortcutKeys(
  keys: readonly string[],
  pairKeys?: readonly string[],
): string {
  return [keys, pairKeys]
    .map((chords) =>
      chords === undefined ? undefined : preferredChord(chords),
    )
    .filter((chord) => chord !== undefined)
    .map((chord) => formatChord(chord))
    .join(" / ");
}

/**
 * Which of an action's chords to show on this platform: the first one, except
 * that a Mac shows the Cmd twin of a Ctrl chord when both exist, and other
 * platforms never show a Cmd chord. `undefined` when nothing applies.
 */
export function preferredChord(
  identifiers: readonly string[],
  mac: boolean = isMacPlatform(),
): string | undefined {
  const usable = mac
    ? identifiers
    : identifiers.filter((identifier) => !isMetaChord(identifier));
  const first = usable[0];
  if (!mac || first === undefined || !first.includes("control+")) return first;
  const metaTwin = first.replace("control+", "meta+");
  return identifiers.includes(metaTwin) ? metaTwin : first;
}

function isMetaChord(identifier: string): boolean {
  return identifier.replace(PHASE_PREFIX, "").split("+").includes("meta");
}

const ARIA_MODIFIER: Record<ModifierName, string> = {
  control: "Control",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
};

const ARIA_KEY: Record<string, string> = {
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  escape: "Escape",
  equal: "=",
  minus: "-",
  bracketleft: "[",
  bracketright: "]",
  slash: "/",
  space: "Space",
};

/** The value of `aria-keyshortcuts` for these chords, keyboard chords only. */
export function ariaKeyShortcuts(identifiers: readonly string[]): string {
  return identifiers
    .filter((identifier) => !/mouse|wheel|click/.test(identifier))
    .map((identifier) => {
      const parts = identifier
        .replace(PHASE_PREFIX, "")
        .split("+")
        .filter((part) => !part.endsWith("?"));
      const key = parts[parts.length - 1];
      const modifiers = WINDOWS_MODIFIER_ORDER.filter((name) =>
        parts.includes(name),
      ).map((name) => ARIA_MODIFIER[name]);
      return [...modifiers, ARIA_KEY[key] ?? formatKeyName(key)].join("+");
    })
    .join(" ");
}

/**
 * Attributes that give an element the shared tooltip with its key caps; with
 * `pairIdentifiers`, both halves of a pair such as `− / +`.
 */
export function shortcutAttributes(
  identifiers: readonly string[],
  pairIdentifiers?: readonly string[],
): {
  "data-shortcut": string;
  "data-shortcut-pair"?: string;
  "aria-keyshortcuts": string;
} {
  const attributes = {
    "data-shortcut": identifiers.join(" "),
    "aria-keyshortcuts": ariaKeyShortcuts([
      ...identifiers,
      ...(pairIdentifiers ?? []),
    ]),
  };
  return pairIdentifiers === undefined
    ? attributes
    : { ...attributes, "data-shortcut-pair": pairIdentifiers.join(" ") };
}

/**
 * The chords an input map binds to an action, without their input phase, read
 * from the map itself so the label follows the binding.
 */
export function chordsForAction(map: EventActionMap, action: string): string[] {
  const chords: string[] = [];
  for (const [normalized, eventAction] of map.entries()) {
    if (eventAction.action !== action) continue;
    const chord = (eventAction.originalEventIdentifier ?? normalized).replace(
      PHASE_PREFIX,
      "",
    );
    if (!chords.includes(chord)) chords.push(chord);
  }
  return chords;
}
