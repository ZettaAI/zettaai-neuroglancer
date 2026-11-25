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
 * Key caps as plain DOM, for the tooltip bubble and upstream-style buttons that
 * are built without a component framework.
 */

import "#src/ui/key_chips.css";

import { chordKeyLabels } from "#src/ui/key_chord_format.js";

export const KEY_CHIP_CLASS = "neuroglancer-key-chip";
export const KEY_CHIPS_CLASS = "neuroglancer-key-chips";

export function makeKeyChips(identifier: string): HTMLElement {
  const chips = document.createElement("span");
  chips.className = KEY_CHIPS_CLASS;
  chips.setAttribute("aria-hidden", "true");
  for (const label of chordKeyLabels(identifier)) {
    const chip = document.createElement("kbd");
    chip.className = KEY_CHIP_CLASS;
    chip.textContent = label;
    chips.appendChild(chip);
  }
  return chips;
}
