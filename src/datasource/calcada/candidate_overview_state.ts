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
 * @file Split error detection: whether it is on, and how flagged pieces are
 * shown. The segment it scores is the proofread segment, and its filters are
 * the trace's own, shared, so the pieces it flags are the ones the trace would
 * offer.
 */

import type { PieceOverview } from "#src/datasource/calcada/candidate_heat.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  verifyBoolean,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

/** The piece split error detection is showing, and where it sits in the list. */
export interface SplitDetectionFocus {
  total: number;
  /** Unset until the proofreader steps onto a piece. */
  index?: number;
  piece?: PieceOverview;
}

const OVERVIEW_ACTIVE_KEY = "active";
const OVERVIEW_DISPLAY_KEY = "show";

/**
 * Red points on a segment left as it is, or flagged pieces recoloured. Points
 * are what proofreaders use; recolouring stays reachable from a link.
 */
export type SplitErrorDisplay = "pieces" | "points";
const DEFAULT_DISPLAY: SplitErrorDisplay = "points";
const OTHER_DISPLAY: SplitErrorDisplay = "pieces";

export class CalcadaOverviewState extends RefCounted implements Trackable {
  readonly changed = new NullarySignal();

  active = new WatchableValue<boolean>(false);
  display = new WatchableValue<SplitErrorDisplay>(DEFAULT_DISPLAY);

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.active.changed.add(reemit));
    this.registerDisposer(this.display.changed.add(reemit));
  }

  reset() {
    this.active.value = false;
  }

  toJSON() {
    const { active } = this;
    if (!active.value) return undefined;
    return {
      [OVERVIEW_ACTIVE_KEY]: true,
      [OVERVIEW_DISPLAY_KEY]:
        this.display.value === DEFAULT_DISPLAY ? undefined : this.display.value,
    };
  }

  restoreState(x: unknown) {
    if (x === undefined || x === null) {
      this.reset();
      return;
    }
    this.active.value =
      verifyOptionalObjectProperty(x, OVERVIEW_ACTIVE_KEY, verifyBoolean) ??
      false;
    this.display.value =
      verifyOptionalObjectProperty(x, OVERVIEW_DISPLAY_KEY, verifyString) ===
      OTHER_DISPLAY
        ? OTHER_DISPLAY
        : DEFAULT_DISPLAY;
  }
}
