/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/** Key caps for Preact components, in the same look as `key_chips.ts`. */

import "#src/ui/key_chips.css";

import {
  chordKeyLabels,
  formatChord,
  preferredChord,
  shownChords,
} from "#src/ui/key_chord_format.js";
import type { ModeShortcut } from "#src/ui/mode_shortcuts.js";

export function KeyCaps({ keys }: { keys: readonly string[] }) {
  const chord = preferredChord(keys);
  if (chord === undefined) {
    return <span class="neuroglancer-key-chips-unbound">unbound</span>;
  }
  return (
    <span class="neuroglancer-key-chips" aria-label={formatChord(chord)}>
      {chordKeyLabels(chord).map((label) => (
        <kbd key={label} class="neuroglancer-key-chip">
          {label}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Every key that does the action, `− / Num−`, for the shortcut sheet: there a
 * key taken by a rebind must visibly go, not leave the action showing a key
 * the annotator never chose.
 */
export function AllKeyCaps({ keys }: { keys: readonly string[] }) {
  const chords = shownChords(keys);
  if (chords.length <= 1) return <KeyCaps keys={keys} />;
  return (
    <span class="neuroglancer-key-chips">
      {chords.map((chord, i) => (
        <span class="neuroglancer-key-chips" key={chord}>
          {i > 0 && <span class="neuroglancer-key-chips-separator">/</span>}
          <KeyCaps keys={[chord]} />
        </span>
      ))}
    </span>
  );
}

/** A shortcut's key caps, or both of a pair such as `− / +`. */
export function ShortcutKeys({ shortcut }: { shortcut: ModeShortcut }) {
  return (
    <span class="neuroglancer-key-chips">
      <KeyCaps keys={shortcut.keys} />
      {shortcut.pairKeys !== undefined && (
        <>
          <span class="neuroglancer-key-chips-separator">/</span>
          <KeyCaps keys={shortcut.pairKeys} />
        </>
      )}
    </span>
  );
}
