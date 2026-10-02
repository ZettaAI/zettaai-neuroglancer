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
 * @file The segment being proofread, chosen first in the Trace tab: Trace
 * seeds on it and split error detection scores it.
 *
 * Remembered by the piece under the point where it was chosen, not by its
 * root: a root dies on every merge and cut, and after a cut the piece is what
 * says which side the proofreader is on.
 */

import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  parseFixedLengthArray,
  verifyFiniteFloat,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

const PIECE_KEY = "piece";
const POINT_KEY = "point";

export class ProofreadSegment extends RefCounted implements Trackable {
  readonly changed = new NullarySignal();

  readonly piece = new WatchableValue<bigint | undefined>(undefined);
  /** Where it was chosen, in global coordinates: the way back to it. */
  readonly point = new WatchableValue<Float32Array | undefined>(undefined);

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.piece.changed.add(reemit));
    this.registerDisposer(this.point.changed.add(reemit));
  }

  /** The point goes first, so whoever follows the piece finds it in place. */
  select(piece: bigint, point: Float32Array | undefined) {
    this.point.value = point;
    this.piece.value = piece;
  }

  clear() {
    this.point.value = undefined;
    this.piece.value = undefined;
  }

  reset() {
    this.clear();
  }

  toJSON() {
    const piece = this.piece.value;
    if (piece === undefined) return undefined;
    const point = this.point.value;
    return {
      [PIECE_KEY]: piece.toString(),
      [POINT_KEY]: point === undefined ? undefined : Array.from(point),
    };
  }

  restoreState(x: unknown) {
    if (x === undefined || x === null) {
      this.reset();
      return;
    }
    const piece = verifyOptionalObjectProperty(x, PIECE_KEY, (value) =>
      BigInt(verifyString(value)),
    );
    const point = verifyOptionalObjectProperty(x, POINT_KEY, (value) =>
      Float32Array.from(
        parseFixedLengthArray([0, 0, 0], value, verifyFiniteFloat),
      ),
    );
    if (piece === undefined) this.clear();
    else this.select(piece, point);
  }
}
