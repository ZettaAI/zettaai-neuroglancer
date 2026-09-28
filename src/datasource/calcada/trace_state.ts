/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  CandidateFilter,
  SemanticClass,
} from "#src/datasource/calcada/candidate_heat.js";
import { SEMANTIC_CLASSES } from "#src/datasource/calcada/candidate_heat.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  parseArray,
  parseFixedLengthArray,
  verifyBoolean,
  verifyFiniteFloat,
  verifyInt,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

/**
 * How much of the seed segment a trace starts from. "segment" is the behaviour
 * that predates the sphere — every candidate the segment has, wherever it is —
 * kept as a deliberate choice rather than as a fallback.
 */
export type TraceScope = "sphere" | "segment";

export const TRACE_SPHERE_RADIUS_DEFAULT_NM = 2000;
export const TRACE_SPHERE_RADIUS_MIN_NM = 100;
export const TRACE_SPHERE_RADIUS_MAX_NM = 50000;

const TRACE_SCOPE_KEY = "scope";
const TRACE_SPHERE_RADIUS_KEY = "sphereRadiusNm";
const TRACE_SPHERE_CENTER_KEY = "sphereCenter";

const TRACE_ACTIVE_KEY = "active";
const TRACE_SEED_KEY = "seedRoot";
const TRACE_MIN_PIECE_VOXELS_KEY = "minPieceVoxels";
const TRACE_REJECTED_BY_KEY = "rejectedBy";
const TRACE_MIN_SCORE_KEY = "minScore";
const TRACE_CENTRE_KEY = "centreOnCandidate";
const TRACE_ZOOM_KEY = "zoomOnCandidate";
const TRACE_SOURCE_MIN_VOXELS_KEY = "sourceMinVoxels";
const TRACE_SOURCE_CLASS_KEY = "sourceClass";
const TRACE_SOURCE_FRACTION_KEY = "sourceMinFraction";
const TRACE_TARGET_CLASS_KEY = "targetClass";
const TRACE_TARGET_FRACTION_KEY = "targetMinFraction";
const CLASS_FRACTION_DEFAULT = 0.8;
// Server-side alias for the authenticated user.
export const TRACE_CURRENT_USER = "me";

function classOrUndefined(name: SemanticClass) {
  return name === "any" ? undefined : name;
}

function fractionOrUndefined(fraction: number) {
  return fraction === CLASS_FRACTION_DEFAULT ? undefined : fraction;
}

function parseClass(value: unknown): SemanticClass {
  const name = verifyString(value) as SemanticClass;
  return SEMANTIC_CLASSES.includes(name) ? name : "any";
}

/**
 * Zetta Trace is a mode, not a tool: a proofreader stays in it while switching
 * to merge or cut and back, so its state cannot live in a tool activation,
 * which neuroglancer tears down the moment another tool takes the single
 * active-tool slot.
 *
 * Only the durable knobs live here, and they are what a shared link restores.
 * The candidate list is deliberately not among them — it is refetched, because
 * a list saved minutes ago describes a graph that has since been edited.
 */
export class ZettaTraceState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  active = new WatchableValue<boolean>(false);
  // Orthogonal to `active`, not a replacement for it: aiming happens both on
  // its own and on top of a live trace, which is what lets T mid-trace open the
  // sights without ending the session. Never serialized — a link restored while
  // aiming would show a sphere with no trace behind it.
  aiming = new WatchableValue<boolean>(false);
  scope = new WatchableValue<TraceScope>("sphere");
  sphereRadiusNm = new WatchableValue<number>(TRACE_SPHERE_RADIUS_DEFAULT_NM);
  sphereCenter = new WatchableValue<Float32Array | undefined>(undefined);
  seedRoot = new WatchableValue<bigint | undefined>(undefined);
  // Candidates whose partner piece is smaller than this are debris the model
  // still scores highly. Zero offers everything.
  minPieceVoxels = new WatchableValue<number>(0);
  // Whose rejections to honour. Empty means anyone's. The literal "me" is
  // resolved by the server, which knows who the request is from — the browser
  // never learns its own user id.
  rejectedBy = new WatchableValue<string[]>([]);
  // One threshold for both the trace and split error detection, so the pieces
  // painted as likely errors are the ones whose candidates the trace offers.
  minScore = new WatchableValue<number>(0);
  // Moving the camera to every candidate costs the proofreader their bearings;
  // both are theirs to turn off.
  centreOnCandidate = new WatchableValue<boolean>(true);
  zoomOnCandidate = new WatchableValue<boolean>(true);
  // What each end of a candidate must be — source the seed's piece at the
  // contact, target the piece it would merge in. Shared with split error
  // detection like the score threshold.
  // The seed's piece at the contact must be at least this large. Checked on
  // the client, from the size each candidate carries; the candidate's own
  // minimum is minPieceVoxels, which the server applies.
  sourceMinVoxels = new WatchableValue<number>(0);
  sourceClass = new WatchableValue<SemanticClass>("any");
  sourceMinFraction = new WatchableValue<number>(CLASS_FRACTION_DEFAULT);
  targetClass = new WatchableValue<SemanticClass>("any");
  targetMinFraction = new WatchableValue<number>(CLASS_FRACTION_DEFAULT);

  // Fires when a merge or a split has rewritten roots. The seed and the
  // candidate are identified by piece from here on: their root ids have just
  // changed, so anything holding a root id is stale.
  graphEdited = new Signal<
    (oldRoots: Uint64Set, newRoots: Uint64Set) => void
  >();

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.active.changed.add(reemit));
    this.registerDisposer(this.aiming.changed.add(reemit));
    this.registerDisposer(this.scope.changed.add(reemit));
    this.registerDisposer(this.sphereRadiusNm.changed.add(reemit));
    this.registerDisposer(this.sphereCenter.changed.add(reemit));
    this.registerDisposer(this.seedRoot.changed.add(reemit));
    this.registerDisposer(this.minPieceVoxels.changed.add(reemit));
    this.registerDisposer(this.rejectedBy.changed.add(reemit));
    this.registerDisposer(this.minScore.changed.add(reemit));
    this.registerDisposer(this.centreOnCandidate.changed.add(reemit));
    this.registerDisposer(this.zoomOnCandidate.changed.add(reemit));
    this.registerDisposer(this.sourceMinVoxels.changed.add(reemit));
    this.registerDisposer(this.sourceClass.changed.add(reemit));
    this.registerDisposer(this.sourceMinFraction.changed.add(reemit));
    this.registerDisposer(this.targetClass.changed.add(reemit));
    this.registerDisposer(this.targetMinFraction.changed.add(reemit));
  }

  /** The shared filters as one value, for the trace and split error detection. */
  get candidateFilter(): CandidateFilter {
    return {
      minScore: this.minScore.value,
      source: {
        minVoxels: this.sourceMinVoxels.value,
        wanted: this.sourceClass.value,
        minFraction: this.sourceMinFraction.value,
      },
      target: {
        minVoxels: this.minPieceVoxels.value,
        wanted: this.targetClass.value,
        minFraction: this.targetMinFraction.value,
      },
    };
  }

  /** Every filter that hides candidates already fetched, without a refetch. */
  get candidateFilterSignals() {
    return [
      this.minScore,
      this.sourceMinVoxels,
      this.sourceClass,
      this.sourceMinFraction,
      this.targetClass,
      this.targetMinFraction,
    ];
  }

  /**
   * What Escape does: put down the sights if they are up, otherwise end the
   * trace.
   *
   * Escape appears in both key maps, and while aiming over a live trace both
   * are bound at once. A key event resolves to a single action, so only one of
   * the two handlers runs — and routing both here is what makes it not matter
   * which. Do NOT call this twice for one press: the second call would see the
   * sights already down and end the session.
   */
  cancelInnermost() {
    if (this.aiming.value) {
      this.aiming.value = false;
      return;
    }
    this.active.value = false;
  }

  reset() {
    this.active.value = false;
    this.aiming.value = false;
    this.seedRoot.value = undefined;
    this.sphereCenter.value = undefined;
  }

  // The seed is re-resolved from its piece rather than remapped from the old
  // root set: a cut splits one root into several, so the set alone cannot say
  // which side the seed ended up on.
  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    if (this.active.value) this.graphEdited.dispatch(oldValues, newValues);
  }

  toJSON() {
    return {
      [TRACE_ACTIVE_KEY]: this.active.value ? true : undefined,
      [TRACE_SEED_KEY]: this.seedRoot.value?.toString(),
      [TRACE_MIN_PIECE_VOXELS_KEY]: this.minPieceVoxels.value || undefined,
      [TRACE_REJECTED_BY_KEY]: this.rejectedBy.value.length
        ? this.rejectedBy.value
        : undefined,
      [TRACE_MIN_SCORE_KEY]: this.minScore.value || undefined,
      [TRACE_CENTRE_KEY]: this.centreOnCandidate.value ? undefined : false,
      [TRACE_ZOOM_KEY]: this.zoomOnCandidate.value ? undefined : false,
      [TRACE_SOURCE_MIN_VOXELS_KEY]: this.sourceMinVoxels.value || undefined,
      [TRACE_SOURCE_CLASS_KEY]: classOrUndefined(this.sourceClass.value),
      [TRACE_SOURCE_FRACTION_KEY]: fractionOrUndefined(
        this.sourceMinFraction.value,
      ),
      [TRACE_TARGET_CLASS_KEY]: classOrUndefined(this.targetClass.value),
      [TRACE_TARGET_FRACTION_KEY]: fractionOrUndefined(
        this.targetMinFraction.value,
      ),
      [TRACE_SCOPE_KEY]: this.scope.value,
      [TRACE_SPHERE_RADIUS_KEY]: this.sphereRadiusNm.value,
      [TRACE_SPHERE_CENTER_KEY]: this.sphereCenter.value
        ? Array.from(this.sphereCenter.value)
        : undefined,
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, TRACE_ACTIVE_KEY, (value) => {
      this.active.value = verifyBoolean(value);
    });
    verifyOptionalObjectProperty(x, TRACE_SEED_KEY, (value) => {
      this.seedRoot.value = BigInt(verifyString(value));
    });
    verifyOptionalObjectProperty(x, TRACE_MIN_PIECE_VOXELS_KEY, (value) => {
      this.minPieceVoxels.value = verifyInt(value);
    });
    verifyOptionalObjectProperty(x, TRACE_REJECTED_BY_KEY, (value) => {
      this.rejectedBy.value = parseArray(value, verifyString);
    });
    verifyOptionalObjectProperty(x, TRACE_MIN_SCORE_KEY, (value) => {
      this.minScore.value = verifyFiniteFloat(value);
    });
    verifyOptionalObjectProperty(x, TRACE_CENTRE_KEY, (value) => {
      this.centreOnCandidate.value = verifyBoolean(value);
    });
    verifyOptionalObjectProperty(x, TRACE_ZOOM_KEY, (value) => {
      this.zoomOnCandidate.value = verifyBoolean(value);
    });
    verifyOptionalObjectProperty(x, TRACE_SOURCE_MIN_VOXELS_KEY, (value) => {
      this.sourceMinVoxels.value = verifyInt(value);
    });
    verifyOptionalObjectProperty(x, TRACE_SOURCE_CLASS_KEY, (value) => {
      this.sourceClass.value = parseClass(value);
    });
    verifyOptionalObjectProperty(x, TRACE_SOURCE_FRACTION_KEY, (value) => {
      this.sourceMinFraction.value = verifyFiniteFloat(value);
    });
    verifyOptionalObjectProperty(x, TRACE_TARGET_CLASS_KEY, (value) => {
      this.targetClass.value = parseClass(value);
    });
    verifyOptionalObjectProperty(x, TRACE_TARGET_FRACTION_KEY, (value) => {
      this.targetMinFraction.value = verifyFiniteFloat(value);
    });
    verifyOptionalObjectProperty(x, TRACE_SCOPE_KEY, (value) => {
      this.scope.value =
        verifyString(value) === "segment" ? "segment" : "sphere";
    });
    verifyOptionalObjectProperty(x, TRACE_SPHERE_RADIUS_KEY, (value) => {
      this.sphereRadiusNm.value = verifyFiniteFloat(value);
    });
    verifyOptionalObjectProperty(x, TRACE_SPHERE_CENTER_KEY, (value) => {
      this.sphereCenter.value = Float32Array.from(
        parseFixedLengthArray([0, 0, 0], value, verifyFiniteFloat),
      );
    });
  }
}
