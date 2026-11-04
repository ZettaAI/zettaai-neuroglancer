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
 * What the keyboard does right now. A mode (a trace, a paint tool) publishes its
 * keys here while it is active; the strip over the viewer and the shortcut sheet
 * show whichever published mode has the highest priority. Publishing by id means
 * several layers in the same mode still produce a single strip.
 */

import { NullarySignal } from "#src/util/signal.js";

export interface ModeShortcut {
  /** Event identifiers, in the order `preferredChord` should consider them. */
  readonly keys: readonly string[];
  /** The other half of a pair shown together, such as `−` and `+` for a size. */
  readonly pairKeys?: readonly string[];
  readonly label: string;
  /** What the key does, for the Hotkeys lists; the short label is for the strip. */
  readonly description?: string;
  /** Too detailed for the strip; shown in the panel list and the sheet. */
  readonly detailOnly?: boolean;
}

export interface PublishedMode {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly shortcuts: readonly ModeShortcut[];
}

export class ModeShortcutRegistry {
  readonly changed = new NullarySignal();
  private readonly modes = new Map<string, PublishedMode>();

  /** Publishes or replaces a mode. Returns the function that withdraws it. */
  publish(mode: PublishedMode): () => void {
    this.modes.set(mode.id, mode);
    this.changed.dispatch();
    return () => {
      if (this.modes.get(mode.id) === mode) {
        this.modes.delete(mode.id);
        this.changed.dispatch();
      }
    };
  }

  get current(): PublishedMode | undefined {
    let best: PublishedMode | undefined;
    for (const mode of this.modes.values()) {
      if (best === undefined || mode.priority > best.priority) best = mode;
    }
    return best;
  }
}

/**
 * Publishes `mode` for as long as `active` is true. Returns the function that
 * stops watching and withdraws it.
 */
export function publishModeWhile(
  registry: ModeShortcutRegistry,
  active: {
    readonly value: boolean;
    readonly changed: { add(listener: () => void): () => void };
  },
  mode: PublishedMode,
): () => void {
  let withdraw: (() => void) | undefined;
  const sync = () => {
    if (active.value && withdraw === undefined) {
      withdraw = registry.publish(mode);
    } else if (!active.value && withdraw !== undefined) {
      withdraw();
      withdraw = undefined;
    }
  };
  sync();
  const stopWatching = active.changed.add(sync);
  return () => {
    stopWatching();
    withdraw?.();
    withdraw = undefined;
  };
}

/**
 * The key that opens the shortcut sheet, as the viewer binds it
 * (`default_input_event_bindings.ts`, action "help"). Labels read it from here.
 */
export const SHORTCUT_SHEET_KEYS: readonly string[] = ["keyh"];

/** One per page: the strip and sheet are too, and modes know no viewer. */
export const modeShortcuts = new ModeShortcutRegistry();
