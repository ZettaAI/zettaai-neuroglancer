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
 * @file Split error detection: whether it is on, and the one segment it scores.
 * Its filters are the trace's own, shared, so the pieces it paints are the ones
 * the trace would offer.
 *
 * Separate from the trace's own state even though both live in the same tab.
 * The overview is what you look at BEFORE choosing where to trace, and it
 * outlives any particular trace seed.
 *
 * The segment is remembered by a piece rather than by its root: a root dies
 * on every merge and cut, the piece that was clicked does not.
 */

import type { PieceOverview } from "#src/datasource/calcada/candidate_heat.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  parseFixedLengthArray,
  verifyBoolean,
  verifyFiniteFloat,
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
const OVERVIEW_SEED_PIECE_KEY = "seedPiece";
const OVERVIEW_SEED_POINT_KEY = "seedPoint";
const OVERVIEW_DISPLAY_KEY = "show";

/** Flagged pieces recoloured, or marked with red points on a segment left as it is. */
export type SplitErrorDisplay = "pieces" | "points";
const DEFAULT_DISPLAY: SplitErrorDisplay = "pieces";

export class CalcadaOverviewState extends RefCounted implements Trackable {
  readonly changed = new NullarySignal();

  active = new WatchableValue<boolean>(false);
  seedPiece = new WatchableValue<bigint | undefined>(undefined);
  // Where the segment was picked, in global coordinates: the way back to it.
  seedPoint = new WatchableValue<Float32Array | undefined>(undefined);
  display = new WatchableValue<SplitErrorDisplay>(DEFAULT_DISPLAY);

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.active.changed.add(reemit));
    this.registerDisposer(this.seedPiece.changed.add(reemit));
    this.registerDisposer(this.seedPoint.changed.add(reemit));
    this.registerDisposer(this.display.changed.add(reemit));
  }

  reset() {
    this.active.value = false;
    this.seedPiece.value = undefined;
    this.seedPoint.value = undefined;
  }

  toJSON() {
    const { active, seedPiece, seedPoint } = this;
    if (!active.value && seedPiece.value === undefined) return undefined;
    return {
      [OVERVIEW_ACTIVE_KEY]: active.value || undefined,
      [OVERVIEW_SEED_PIECE_KEY]: seedPiece.value?.toString(),
      [OVERVIEW_SEED_POINT_KEY]: seedPoint.value
        ? Array.from(seedPoint.value)
        : undefined,
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
    this.seedPiece.value = verifyOptionalObjectProperty(
      x,
      OVERVIEW_SEED_PIECE_KEY,
      (value) => BigInt(verifyString(value)),
    );
    this.display.value =
      verifyOptionalObjectProperty(x, OVERVIEW_DISPLAY_KEY, verifyString) ===
      "points"
        ? "points"
        : DEFAULT_DISPLAY;
    this.seedPoint.value = verifyOptionalObjectProperty(
      x,
      OVERVIEW_SEED_POINT_KEY,
      (value) =>
        Float32Array.from(
          parseFixedLengthArray([0, 0, 0], value, verifyFiniteFloat),
        ),
    );
  }
}
