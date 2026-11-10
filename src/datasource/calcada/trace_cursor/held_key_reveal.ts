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
 * @file Something shown only while a key is held. A hold is a keydown and its
 * keyup, which an action map cannot express: it fires on keydown only.
 */

import type { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function typedIntoField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (
    target !== null &&
    (TEXT_ENTRY_TAGS.has(target.tagName) || target.isContentEditable)
  );
}

export class HeldKeyReveal extends RefCounted {
  /** `key` is an event identifier such as "keyj". */
  constructor(
    key: string,
    private readonly revealed: WatchableValue<boolean>,
  ) {
    super();
    const isRevealKey = (event: KeyboardEvent) =>
      event.code.toLowerCase() === key;
    this.registerEventListener(document, "keydown", (event: Event) => {
      const key = event as KeyboardEvent;
      if (!isRevealKey(key) || typedIntoField(key)) return;
      if (key.ctrlKey || key.metaKey || key.altKey) return;
      this.revealed.value = true;
    });
    this.registerEventListener(document, "keyup", (event: Event) => {
      if (isRevealKey(event as KeyboardEvent)) this.revealed.value = false;
    });
    this.registerEventListener(window, "blur", () => {
      this.revealed.value = false;
    });
    this.registerDisposer(() => {
      this.revealed.value = false;
    });
  }
}
