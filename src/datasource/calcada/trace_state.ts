/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { GroupNode } from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  emptyFilterTree,
  minCandidateVoxels,
  parseFilterDocument,
  serializeFilterTree,
  withNodeIds,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import type { LegacyFilter } from "#src/datasource/calcada/candidate_filter_v1.js";
import { legacyFilterTree } from "#src/datasource/calcada/candidate_filter_v1.js";
import type { SemanticClass } from "#src/datasource/calcada/candidate_heat.js";
import { SEMANTIC_CLASSES } from "#src/datasource/calcada/candidate_heat.js";
import { WatchableValue } from "#src/trackable_value.js";
import {
  DEFAULT_SIDE_PANEL_LOCATION,
  TrackableSidePanelLocation,
} from "#src/ui/side_panel_location.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  parseArray,
  parseFixedLengthArray,
  verifyBoolean,
  verifyFiniteFloat,
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
const RADIUS_STEP_FACTOR = 1.25;

export function stepTraceSphereRadiusNm(
  radiusNm: number,
  direction: 1 | -1,
): number {
  const next =
    direction === 1
      ? radiusNm * RADIUS_STEP_FACTOR
      : radiusNm / RADIUS_STEP_FACTOR;
  return Math.min(
    TRACE_SPHERE_RADIUS_MAX_NM,
    Math.max(TRACE_SPHERE_RADIUS_MIN_NM, next),
  );
}

const TRACE_SCOPE_KEY = "scope";
const TRACE_SPHERE_RADIUS_KEY = "sphereRadiusNm";
const TRACE_SPHERE_CENTER_KEY = "sphereCenter";

const TRACE_FILTER_KEY = "filter";
const TRACE_FILTER_PRESET_KEY = "filterPreset";
const TRACE_FILTER_EDITOR_KEY = "filterEditor";
const TRACE_SCORE_RANGE_KEY = "scoreRange";

/** Lower and upper score a candidate may have, both ends included. */
export type ScoreRange = readonly [number, number];
export const FULL_SCORE_RANGE: ScoreRange = [0, 1];

export function withinScoreRange(score: number, [low, high]: ScoreRange) {
  return score >= low && score <= high;
}

// The + / − step while tracing: twenty stops between 0 and 1.
const SCORE_STEPS_PER_UNIT = 20;

/**
 * Raise or lower the lowest score by one step, onto a whole step so repeated
 * presses do not drift, and never past zero or the highest score.
 */
export function stepScoreRangeLow(
  [low, high]: ScoreRange,
  direction: 1 | -1,
): ScoreRange {
  const stepped =
    (Math.round(low * SCORE_STEPS_PER_UNIT) + direction) / SCORE_STEPS_PER_UNIT;
  return [Math.min(high, Math.max(FULL_SCORE_RANGE[0], stepped)), high];
}

function parseScoreRange(value: unknown): ScoreRange {
  const [a, b] = parseFixedLengthArray([0, 0], value, verifyFiniteFloat);
  const clamp = (bound: number) =>
    Math.min(FULL_SCORE_RANGE[1], Math.max(FULL_SCORE_RANGE[0], bound));
  return [clamp(Math.min(a, b)), clamp(Math.max(a, b))];
}
export const FILTER_EDITOR_WIDTH_PX = 1280;
export const FILTER_EDITOR_MIN_WIDTH_PX = 320;
const DEFAULT_FILTER_EDITOR_LOCATION = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: "right" as const,
  // Its own column beside the layer panel (column 0), not stacked under it.
  col: 1,
  size: FILTER_EDITOR_WIDTH_PX,
  minSize: FILTER_EDITOR_MIN_WIDTH_PX,
  visible: false,
};

const TRACE_ACTIVE_KEY = "active";
const TRACE_SEED_KEY = "seedRoot";
// Links written before the filter tree carried the filter as these separate
// keys. They are read so an old link opens with its filter, never written.
const TRACE_MIN_PIECE_VOXELS_KEY = "minPieceVoxels";
const TRACE_REJECTED_BY_KEY = "rejectedBy";
const TRACE_MIN_SCORE_KEY = "minScore";
const TRACE_CENTRE_KEY = "centreOnCandidate";
const TRACE_ZOOM_KEY = "zoomOnCandidate";
const TRACE_KEEP_SPLIT_PARTS_KEY = "keepSplitParts";
const TRACE_SOURCE_MIN_VOXELS_KEY = "sourceMinVoxels";
const TRACE_SOURCE_CLASS_KEY = "sourceClass";
const TRACE_SOURCE_FRACTION_KEY = "sourceMinFraction";
const TRACE_TARGET_CLASS_KEY = "targetClass";
const TRACE_TARGET_FRACTION_KEY = "targetMinFraction";
const CLASS_FRACTION_DEFAULT = 0.8;
// Server-side alias for the authenticated user.
export const TRACE_CURRENT_USER = "me";

function emptyToUndefined(json: object) {
  return Object.keys(json).length > 0 ? json : undefined;
}

function parseClass(value: unknown): SemanticClass {
  const name = verifyString(value) as SemanticClass;
  return SEMANTIC_CLASSES.includes(name) ? name : "any";
}

function readLegacyFilter(x: unknown): LegacyFilter {
  const number = (key: string, fallback: number) =>
    verifyOptionalObjectProperty(x, key, verifyFiniteFloat) ?? fallback;
  const cls = (key: string) =>
    verifyOptionalObjectProperty(x, key, parseClass) ?? "any";
  return {
    minScore: number(TRACE_MIN_SCORE_KEY, 0),
    seedMinVoxels: number(TRACE_SOURCE_MIN_VOXELS_KEY, 0),
    candidateMinVoxels: number(TRACE_MIN_PIECE_VOXELS_KEY, 0),
    seedClass: cls(TRACE_SOURCE_CLASS_KEY),
    seedMinFraction: number(TRACE_SOURCE_FRACTION_KEY, CLASS_FRACTION_DEFAULT),
    candidateClass: cls(TRACE_TARGET_CLASS_KEY),
    candidateMinFraction: number(
      TRACE_TARGET_FRACTION_KEY,
      CLASS_FRACTION_DEFAULT,
    ),
  };
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
  // The candidate filter, shared by the trace and split error detection so the
  // pieces painted as likely errors are the ones the trace will offer.
  filter = new WatchableValue<GroupNode>(emptyFilterTree());
  // The saved preset the filter was loaded from, if any. Only its owner's list
  // knows it; anyone else opening the link sees the same tree, unnamed.
  filterPresetId = new WatchableValue<string | undefined>(undefined);
  // Applied with the filter, kept apart from it: a range is tuned per sitting,
  // a filter is saved.
  scoreRange = new WatchableValue<ScoreRange>(FULL_SCORE_RANGE);
  // Where the filter editor column sits, and whether it is open.
  filterEditor = new TrackableSidePanelLocation(DEFAULT_FILTER_EDITOR_LOCATION);
  // The one part of the filter the server applies: the smallest candidate it
  // can pass, so debris does not crowd the rest out of the fetch limit.
  // Derived from `filter`, never set or saved on its own.
  readonly minPieceVoxels = new WatchableValue<number>(0);
  // Whose rejections to honour. Empty means anyone's. The literal "me" is
  // resolved by the server, which knows who the request is from — the browser
  // never learns its own user id.
  rejectedBy = new WatchableValue<string[]>([]);
  // Moving the camera to every candidate costs the proofreader their bearings;
  // both are theirs to turn off.
  centreOnCandidate = new WatchableValue<boolean>(true);
  zoomOnCandidate = new WatchableValue<boolean>(true);
  // Keep the parts of a segment cut during the trace on screen, rather than
  // only the seed and the candidate.
  keepSplitParts = new WatchableValue<boolean>(false);

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
    this.registerDisposer(this.rejectedBy.changed.add(reemit));
    this.registerDisposer(this.centreOnCandidate.changed.add(reemit));
    this.registerDisposer(this.zoomOnCandidate.changed.add(reemit));
    this.registerDisposer(this.keepSplitParts.changed.add(reemit));
    this.registerDisposer(
      this.filter.changed.add(() => {
        this.minPieceVoxels.value = minCandidateVoxels(this.filter.value);
      }),
    );
    this.registerDisposer(this.filter.changed.add(reemit));
    this.registerDisposer(this.filterPresetId.changed.add(reemit));
    this.registerDisposer(this.scoreRange.changed.add(reemit));
    this.registerDisposer(this.filterEditor.changed.add(reemit));
  }

  /** Every filter change hides or shows queued entries without a refetch. */
  get candidateFilterSignals() {
    return [this.filter, this.scoreRange];
  }

  /**
   * What + / − do: resize the sphere while aiming, otherwise move the lowest
   * score. Routed here from every key map for the reason given at
   * cancelInnermost: only one of the bound maps gets the press.
   */
  stepPlusMinus(direction: 1 | -1) {
    if (this.aiming.value) {
      this.sphereRadiusNm.value = stepTraceSphereRadiusNm(
        this.sphereRadiusNm.value,
        direction,
      );
      return;
    }
    this.scoreRange.value = stepScoreRangeLow(this.scoreRange.value, direction);
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
      [TRACE_REJECTED_BY_KEY]: this.rejectedBy.value.length
        ? this.rejectedBy.value
        : undefined,
      [TRACE_CENTRE_KEY]: this.centreOnCandidate.value ? undefined : false,
      [TRACE_ZOOM_KEY]: this.zoomOnCandidate.value ? undefined : false,
      [TRACE_KEEP_SPLIT_PARTS_KEY]: this.keepSplitParts.value || undefined,
      [TRACE_FILTER_KEY]:
        this.filter.value.children.length > 0
          ? serializeFilterTree(this.filter.value)
          : undefined,
      [TRACE_FILTER_PRESET_KEY]: this.filterPresetId.value,
      [TRACE_SCORE_RANGE_KEY]:
        this.scoreRange.value[0] === FULL_SCORE_RANGE[0] &&
        this.scoreRange.value[1] === FULL_SCORE_RANGE[1]
          ? undefined
          : [...this.scoreRange.value],
      [TRACE_FILTER_EDITOR_KEY]: emptyToUndefined(this.filterEditor.toJSON()),
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
    verifyOptionalObjectProperty(x, TRACE_REJECTED_BY_KEY, (value) => {
      this.rejectedBy.value = parseArray(value, verifyString);
    });
    verifyOptionalObjectProperty(x, TRACE_CENTRE_KEY, (value) => {
      this.centreOnCandidate.value = verifyBoolean(value);
    });
    this.keepSplitParts.value =
      verifyOptionalObjectProperty(
        x,
        TRACE_KEEP_SPLIT_PARTS_KEY,
        verifyBoolean,
      ) ?? false;
    verifyOptionalObjectProperty(x, TRACE_ZOOM_KEY, (value) => {
      this.zoomOnCandidate.value = verifyBoolean(value);
    });
    const linked = verifyOptionalObjectProperty(
      x,
      TRACE_FILTER_KEY,
      (value) => {
        const tree = parseFilterDocument(value);
        if (tree === undefined) {
          console.warn("[calcada] ignoring a malformed trace filter", value);
        }
        return tree;
      },
    );
    this.filter.value =
      linked ?? withNodeIds(legacyFilterTree(readLegacyFilter(x)));
    this.filterPresetId.value = verifyOptionalObjectProperty(
      x,
      TRACE_FILTER_PRESET_KEY,
      verifyString,
    );
    this.filterEditor.restoreState(x?.[TRACE_FILTER_EDITOR_KEY]);
    this.scoreRange.value =
      verifyOptionalObjectProperty(x, TRACE_SCORE_RANGE_KEY, parseScoreRange) ??
      FULL_SCORE_RANGE;
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
