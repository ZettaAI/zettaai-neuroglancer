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
 * @file Whether split error detection is on. Its filters are the trace's own,
 * shared, so the pieces it paints are the ones the trace would offer.
 *
 * Separate from the trace's own state even though both live in the same tab.
 * The overview is what you look at BEFORE choosing where to trace, and it
 * outlives any particular seed.
 */

import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { verifyBoolean, verifyOptionalObjectProperty } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

const OVERVIEW_ACTIVE_KEY = "active";

export class CalcadaOverviewState extends RefCounted implements Trackable {
  readonly changed = new NullarySignal();

  active = new WatchableValue<boolean>(false);

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.active.changed.add(reemit));
  }

  reset() {
    this.active.value = false;
  }

  toJSON() {
    if (!this.active.value) return undefined;
    return { [OVERVIEW_ACTIVE_KEY]: true };
  }

  restoreState(x: unknown) {
    if (x === undefined || x === null) {
      this.reset();
      return;
    }
    verifyOptionalObjectProperty(x, OVERVIEW_ACTIVE_KEY, (value) => {
      this.active.value = verifyBoolean(value);
    });
  }
}
