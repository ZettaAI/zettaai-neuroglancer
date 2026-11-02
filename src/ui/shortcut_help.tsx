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
 * Over the viewer: the strip with the current mode's keys, and the full sheet on
 * H. Both read `modeShortcuts`, so neither knows about Trace or the edit tools.
 */

import "#src/ui/shortcut_help.css";

import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { keyboardEventToIdentifier } from "#src/editing/keybind_event.js";
import type { EditKeybindName } from "#src/editing/session_hotkey_binder.js";
import {
  effectiveEditKeybinds,
  findEditKeybindConflict,
} from "#src/editing/session_hotkey_binder.js";
import type { EditKeybindOverrides } from "#src/editing/tooling/tooling_persist.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { KeyCaps, ShortcutKeys } from "#src/ui/key_caps.js";
import { formatChord, preferredChord } from "#src/ui/key_chord_format.js";
import { modeShortcuts, SHORTCUT_SHEET_KEYS } from "#src/ui/mode_shortcuts.js";
import type { ShortcutRow } from "#src/ui/shortcut_catalog.js";
import {
  buildShortcutSections,
  filterShortcutSections,
} from "#src/ui/shortcut_catalog.js";
import type { EventActionMap } from "#src/util/event_action_map.js";

const STRIP_HIDDEN_STORAGE_KEY = "neuroglancer-mode-shortcuts-hidden";

function readStripHidden(): boolean {
  try {
    return localStorage.getItem(STRIP_HIDDEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Whether this browser asked not to see the strip; changed from either UI. */
export const modeStripHidden = new WatchableValue<boolean>(readStripHidden());
modeStripHidden.changed.add(() => {
  try {
    localStorage.setItem(
      STRIP_HIDDEN_STORAGE_KEY,
      String(modeStripHidden.value),
    );
  } catch {
    // Unavailable storage only means the choice lasts for this page.
  }
});

function useCurrentMode() {
  const [mode, setMode] = useState(modeShortcuts.current);
  useEffect(() => {
    setMode(modeShortcuts.current);
    return modeShortcuts.changed.add(() => setMode(modeShortcuts.current));
  }, []);
  return mode;
}

export function ModeShortcutStrip() {
  const mode = useCurrentMode();
  const hidden = useWatchable(modeStripHidden);
  if (mode === undefined || hidden) return null;
  return (
    <div class="neuroglancer-mode-strip" role="status">
      <span class="neuroglancer-mode-strip-title">{mode.title}</span>
      {mode.shortcuts
        .filter(
          (shortcut) =>
            shortcut.detailOnly !== true &&
            preferredChord(shortcut.keys) !== undefined,
        )
        .map((shortcut) => (
          <span class="neuroglancer-mode-strip-item" key={shortcut.label}>
            <ShortcutKeys shortcut={shortcut} />
            {shortcut.label}
          </span>
        ))}
      <span class="neuroglancer-mode-strip-item">
        <KeyCaps keys={SHORTCUT_SHEET_KEYS} />
        All
      </span>
      <button
        type="button"
        class="neuroglancer-mode-strip-close"
        aria-label="Hide this strip"
        data-tooltip="Hide this strip. Turn it back on from the shortcut sheet."
        onClick={() => {
          modeStripHidden.value = true;
        }}
      >
        ✕
      </button>
    </div>
  );
}

interface ShortcutSheetProps {
  open: WatchableValue<boolean>;
  editKeybindOverrides: WatchableValueInterface<EditKeybindOverrides>;
  setEditKeybind: (name: string, keys: readonly string[]) => void;
  inputMaps: readonly EventActionMap[];
  activeSession: WatchableValueInterface<unknown>;
  openFullReference: () => void;
}

export function ShortcutSheet(props: ShortcutSheetProps) {
  const open = useWatchable(props.open);
  if (!open) return null;
  return <OpenShortcutSheet {...props} />;
}

function OpenShortcutSheet({
  open,
  editKeybindOverrides,
  setEditKeybind,
  inputMaps,
  activeSession,
  openFullReference,
}: ShortcutSheetProps) {
  const sessionActive = useWatchable(activeSession) !== undefined;
  const overrides = useWatchable(editKeybindOverrides);
  const stripHidden = useWatchable(modeStripHidden);
  const mode = useCurrentMode();
  const [query, setQuery] = useState("");
  const [capturing, setCapturingState] = useState<EditKeybindName | null>(null);
  // Read by the key listener, which must see a finished capture at once: effects
  // run after paint, and a quick Esc would otherwise only end a capture already
  // over instead of closing the sheet.
  const capturingNow = useRef<EditKeybindName | null>(null);
  const setCapturing = (name: EditKeybindName | null) => {
    capturingNow.current = name;
    setCapturingState(name);
  };
  const [message, setMessage] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const sheetElement = useRef<HTMLDivElement>(null);

  const editKeys = useMemo(() => effectiveEditKeybinds(overrides), [overrides]);
  const sections = useMemo(
    () =>
      filterShortcutSections(
        buildShortcutSections(editKeys, inputMaps, sessionActive),
        query,
      ),
    [editKeys, inputMaps, sessionActive, query],
  );

  // Focus comes back to where it was, so the viewer's keys work again on close.
  useEffect(() => {
    const previousFocus = document.activeElement;
    searchInput.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const capturingAction = capturingNow.current;
      if (capturingAction === null) {
        if (event.code === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          open.value = false;
          return;
        }
        // A key pressed in the sheet belongs to the sheet: an arrow on its Close
        // button must not reach Trace and accept a candidate.
        if (
          event.target instanceof Node &&
          sheetElement.current?.contains(event.target)
        ) {
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        setCapturing(null);
        setMessage("");
        return;
      }
      const identifier = keyboardEventToIdentifier(event);
      if (identifier === undefined) return;
      const conflict = findEditKeybindConflict(
        capturingAction,
        identifier,
        editKeys,
        inputMaps,
      );
      if (conflict !== undefined) {
        setMessage(
          `${formatChord(identifier)} already does "${conflict}". Press another key, or Esc to cancel.`,
        );
        return;
      }
      setEditKeybind(capturingAction, [identifier]);
      setCapturing(null);
      setMessage("");
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [editKeys, inputMaps, open, setEditKeybind]);

  const renderRow = (row: ShortcutRow) => (
    <div class="neuroglancer-shortcut-row" key={row.label}>
      <span>{row.label}</span>
      {row.rebind === undefined ? (
        <KeyCaps keys={row.keys} />
      ) : (
        <button
          type="button"
          class={
            "neuroglancer-shortcut-rebind" +
            (capturing === row.rebind ? " capturing" : "")
          }
          data-tooltip="Click, then press the new key"
          aria-label={`Change the key for ${row.label}`}
          onClick={() => {
            setMessage("");
            setCapturing(row.rebind!);
          }}
        >
          {capturing === row.rebind ? (
            "Press a key…"
          ) : (
            <KeyCaps keys={row.keys} />
          )}
        </button>
      )}
    </div>
  );

  return (
    <div
      ref={sheetElement}
      class="neuroglancer-shortcut-sheet"
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div class="neuroglancer-shortcut-sheet-header">
        <strong>Keyboard shortcuts</strong>
        <input
          ref={searchInput}
          id="neuroglancer-shortcut-search"
          type="text"
          placeholder="Search…"
          aria-label="Search shortcuts"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button
          type="button"
          class="neuroglancer-shortcut-link"
          onClick={() => {
            open.value = false;
          }}
        >
          <KeyCaps keys={["escape"]} /> Close
        </button>
      </div>
      {message !== "" && (
        <p class="neuroglancer-shortcut-message" role="alert">
          {message}
        </p>
      )}
      {mode !== undefined && query.trim() === "" && (
        <section class="neuroglancer-shortcut-now">
          <h3>Now: {mode.title}</h3>
          <div class="neuroglancer-shortcut-now-rows">
            {mode.shortcuts.map((shortcut) => (
              <div class="neuroglancer-shortcut-row" key={shortcut.label}>
                <span>{shortcut.label}</span>
                <ShortcutKeys shortcut={shortcut} />
              </div>
            ))}
          </div>
        </section>
      )}
      <div class="neuroglancer-shortcut-columns">
        {sections.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            {section.rows.map(renderRow)}
          </section>
        ))}
        {sections.length === 0 && (
          <p class="neuroglancer-shortcut-empty">
            No shortcut matches “{query}”.
          </p>
        )}
      </div>
      <div class="neuroglancer-shortcut-sheet-footer">
        <label>
          <input
            type="checkbox"
            checked={!stripHidden}
            onChange={(event) => {
              modeStripHidden.value = !event.currentTarget.checked;
            }}
          />
          Show the current mode's keys over the viewer
        </label>
        <button
          type="button"
          class="neuroglancer-shortcut-link"
          onClick={openFullReference}
        >
          Full reference
        </button>
      </div>
    </div>
  );
}
