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
 * @file The knobs of the candidate overview: which pieces of a segment still
 * have work in them, and which of those are worth this proofreader's time.
 *
 * Separate from the trace's own state even though both live in the same tab.
 * The overview is what you look at BEFORE choosing where to trace, and it
 * outlives any particular seed.
 */

import type { SemanticClass } from "#src/datasource/calcada/candidate_heat.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  verifyBoolean,
  verifyFiniteFloat,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

const OVERVIEW_ACTIVE_KEY = "active";
const OVERVIEW_MIN_SCORE_KEY = "minScore";
const OVERVIEW_CLASS_KEY = "semanticClass";
const OVERVIEW_MIN_FRACTION_KEY = "minClassFraction";

const SEMANTIC_CLASSES: readonly SemanticClass[] = [
  "any",
  "perikaryon",
  "dendrite",
  "axon",
  "glia",
  "vasculature",
  "nucleus",
  "ecs",
  "other",
];

export const OVERVIEW_MIN_FRACTION_DEFAULT = 0.8;

export class CalcadaOverviewState extends RefCounted implements Trackable {
  readonly changed = new NullarySignal();

  active = new WatchableValue<boolean>(false);
  /** Candidates below this score do not warm a piece at all. */
  minScore = new WatchableValue<number>(0);
  semanticClass = new WatchableValue<SemanticClass>("any");
  minClassFraction = new WatchableValue<number>(OVERVIEW_MIN_FRACTION_DEFAULT);

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.active.changed.add(reemit));
    this.registerDisposer(this.minScore.changed.add(reemit));
    this.registerDisposer(this.semanticClass.changed.add(reemit));
    this.registerDisposer(this.minClassFraction.changed.add(reemit));
  }

  reset() {
    this.active.value = false;
  }

  toJSON() {
    if (!this.active.value) return undefined;
    return {
      [OVERVIEW_ACTIVE_KEY]: true,
      [OVERVIEW_MIN_SCORE_KEY]: this.minScore.value || undefined,
      [OVERVIEW_CLASS_KEY]:
        this.semanticClass.value === "any"
          ? undefined
          : this.semanticClass.value,
      [OVERVIEW_MIN_FRACTION_KEY]: this.minClassFraction.value,
    };
  }

  restoreState(x: unknown) {
    if (x === undefined || x === null) {
      this.reset();
      return;
    }
    verifyOptionalObjectProperty(x, OVERVIEW_ACTIVE_KEY, (value) => {
      this.active.value = verifyBoolean(value);
    });
    verifyOptionalObjectProperty(x, OVERVIEW_MIN_SCORE_KEY, (value) => {
      this.minScore.value = verifyFiniteFloat(value);
    });
    verifyOptionalObjectProperty(x, OVERVIEW_CLASS_KEY, (value) => {
      const name = verifyString(value) as SemanticClass;
      if (SEMANTIC_CLASSES.includes(name)) this.semanticClass.value = name;
    });
    verifyOptionalObjectProperty(x, OVERVIEW_MIN_FRACTION_KEY, (value) => {
      this.minClassFraction.value = verifyFiniteFloat(value);
    });
  }
}

export { SEMANTIC_CLASSES };
