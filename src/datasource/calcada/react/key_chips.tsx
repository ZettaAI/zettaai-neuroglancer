/** @jsxImportSource react */
/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/ui/key_chips.css";

import { chordKeyLabels, preferredChord } from "#src/ui/key_chord_format.js";

export function KeyChips({ keys }: { keys: readonly string[] }) {
  const chord = preferredChord(keys);
  if (chord === undefined) return null;
  return (
    <span className="neuroglancer-key-chips" aria-hidden="true">
      {chordKeyLabels(chord).map((label) => (
        <kbd key={label} className="neuroglancer-key-chip">
          {label}
        </kbd>
      ))}
    </span>
  );
}
