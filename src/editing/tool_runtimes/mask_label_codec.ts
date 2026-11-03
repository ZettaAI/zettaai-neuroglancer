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
 * @file Label codec for the z-extrapolation `propagate_mask` protocol.
 *
 * The backend model works in a compact LABEL space: the mask it receives and
 * the mask it returns hold small integers 1..N (0 = background), never real
 * segment IDs. This module owns the bijection between the tracked segment IDs
 * (real, `bigint`) and those labels:
 *  - {@link buildLabelMap} derives it once per run,
 *  - {@link labelizeMaskSlice} encodes the outgoing mask slice,
 *  - {@link delabelizeMaskSlice} decodes the model's prediction back into real
 *    IDs plus a per-voxel write gate.
 *
 * Labels travel as `uint8`, so at most {@link MAX_TRACKED_SEGMENTS} segments can
 * be tracked in one run; {@link buildLabelMap} enforces that with a typed error
 * the panel surfaces. Because the whole protocol lives in label space, it is
 * agnostic to the mask layer's real voxel data type.
 */

/** Maximum tracked segments in one propagation (labels must fit in `uint8`). */
export const MAX_TRACKED_SEGMENTS = 255;

export interface LabelMap {
  /** Real segment ID → its label (1..N). */
  readonly idToLabel: ReadonlyMap<bigint, number>;
  /** Label (1..N) → its real segment ID. */
  readonly labelToId: ReadonlyMap<number, bigint>;
}

/** Thrown when more than {@link MAX_TRACKED_SEGMENTS} segments are tracked. */
export class TooManyTrackedSegmentsError extends Error {
  constructor(readonly requested: number) {
    super(
      `Z-extrapolation can track at most ${MAX_TRACKED_SEGMENTS} segments per ` +
        `run, but ${requested} were selected.`,
    );
    this.name = "TooManyTrackedSegmentsError";
  }
}

/**
 * Build the label bijection for `trackedIds`. Background (`0n`) and duplicate
 * IDs are dropped; the surviving IDs are numbered 1..N in first-seen order so a
 * stable selection yields a stable encoding.
 *
 * @throws {TooManyTrackedSegmentsError} if more than 255 distinct IDs remain.
 */
export function buildLabelMap(trackedIds: readonly bigint[]): LabelMap {
  const idToLabel = new Map<bigint, number>();
  const labelToId = new Map<number, bigint>();
  for (const id of trackedIds) {
    if (id === 0n || idToLabel.has(id)) continue;
    const label = idToLabel.size + 1;
    idToLabel.set(id, label);
    labelToId.set(label, id);
  }
  if (idToLabel.size > MAX_TRACKED_SEGMENTS) {
    throw new TooManyTrackedSegmentsError(idToLabel.size);
  }
  return { idToLabel, labelToId };
}

/**
 * Encode a mask slice into labels. Each voxel's value is matched against the
 * tracked IDs; a tracked voxel becomes its label (1..N), every other voxel
 * becomes 0. Every integer mask data type is handled: `uint64` (`bigint`)
 * slices and numeric (`uint8`/`uint16`/`uint32`) slices alike.
 */
export function labelizeMaskSlice(
  values: ArrayLike<number | bigint>,
  idToLabel: ReadonlyMap<bigint, number>,
): Uint8Array {
  if (values instanceof BigUint64Array) {
    return labelizeUint64Slice(values, idToLabel);
  }
  if (isNumericVoxelArray(values)) {
    return labelizeNumericSlice(values, idToLabel);
  }
  return labelizeAnySlice(values, idToLabel);
}

/**
 * The distinct non-zero segment IDs in a mask slice, in first-seen order
 * (z-extrapolation auto-detect).
 */
export function distinctNonZeroSegmentIds(
  values: ArrayLike<number | bigint>,
): bigint[] {
  const ids = new Set<bigint>();
  if (values instanceof BigUint64Array) {
    forEachUint64Run(values, (low, high) => {
      if (low !== 0 || high !== 0) ids.add(joinUint64(low, high));
    });
  } else if (isNumericVoxelArray(values)) {
    forEachNumericRun(values, (value) => {
      if (value !== 0) ids.add(BigInt(value));
    });
  } else {
    for (let i = 0; i < values.length; i++) {
      const raw = values[i];
      const id = typeof raw === "bigint" ? raw : BigInt(raw);
      if (id !== 0n) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Clear the write gate wherever the target slice already holds one of
 * `protectedIds` (TM-518): an untracked segment keeps its voxels even where
 * the prediction for a tracked segment grows over it. `existing` is the target
 * slice as it is now, in the same layout as `valueMask`.
 */
export function protectSegmentVoxels(
  valueMask: Uint8Array,
  existing: ArrayLike<number | bigint>,
  protectedIds: readonly bigint[],
): void {
  if (protectedIds.length === 0) return;
  const isProtected = new Set(protectedIds);
  const clearRun = (id: bigint, runStart: number, runEnd: number) => {
    if (isProtected.has(id)) valueMask.fill(0, runStart, runEnd);
  };
  if (existing instanceof BigUint64Array) {
    forEachUint64Run(existing, (low, high, runStart, runEnd) =>
      clearRun(joinUint64(low, high), runStart, runEnd),
    );
  } else if (isNumericVoxelArray(existing)) {
    // Compared as numbers: no BigInt per run (and none of a non-integer).
    const isProtectedNumber = new Set(
      protectedIds
        .filter((id) => id <= BigInt(Number.MAX_SAFE_INTEGER))
        .map(Number),
    );
    forEachNumericRun(existing, (value, runStart, runEnd) => {
      if (isProtectedNumber.has(value)) valueMask.fill(0, runStart, runEnd);
    });
  } else {
    for (let i = 0; i < existing.length; i++) {
      const raw = existing[i];
      clearRun(typeof raw === "bigint" ? raw : BigInt(raw), i, i + 1);
    }
  }
}

export interface DecodedMaskSlice {
  /** Predicted segment ID per voxel (`0n` where nothing was predicted). */
  readonly ids: BigUint64Array;
  /** Write gate: 1 where a segment was predicted, 0 elsewhere. */
  readonly valueMask: Uint8Array;
}

/**
 * Decode the model's predicted label mask back into real segment IDs. A voxel
 * whose label maps to a tracked ID yields that ID and a set write-gate bit;
 * label 0 — and any label the map does not know — yields `0n` and a clear bit,
 * so the caller's `writeRegion` leaves those voxels untouched rather than
 * erasing them. IDs are returned as `bigint`; the write path narrows them to the
 * mask layer's real data type.
 */
export function delabelizeMaskSlice(
  labels: ArrayLike<number>,
  labelToId: ReadonlyMap<number, bigint>,
): DecodedMaskSlice {
  const idByLabel = idByLabelTable(labelToId);
  const ids = new BigUint64Array(labels.length);
  const valueMask = new Uint8Array(labels.length);
  // Predictions are long runs of one label: fill each run at once instead of
  // storing a `bigint` per voxel (the slow part).
  forEachNumericRun(labels, (label, runStart, runEnd) => {
    const id = idByLabel[label];
    if (id === undefined) return;
    ids.fill(id, runStart, runEnd);
    valueMask.fill(1, runStart, runEnd);
  });
  return { ids, valueMask };
}

type NumericVoxelArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

function isNumericVoxelArray(
  values: ArrayLike<number | bigint>,
): values is NumericVoxelArray {
  return (
    ArrayBuffer.isView(values) &&
    !(values instanceof DataView) &&
    !(values instanceof BigInt64Array) &&
    !(values instanceof BigUint64Array)
  );
}

/** Label per tracked ID as a plain number key (numeric masks hold only safe integers). */
function labelByNumber(
  idToLabel: ReadonlyMap<bigint, number>,
): Map<number, number> {
  const byNumber = new Map<number, number>();
  for (const [id, label] of idToLabel) {
    if (id <= BigInt(Number.MAX_SAFE_INTEGER)) byNumber.set(Number(id), label);
  }
  return byNumber;
}

function labelizeNumericSlice(
  values: NumericVoxelArray,
  idToLabel: ReadonlyMap<bigint, number>,
): Uint8Array {
  const labels = new Uint8Array(values.length);
  const byNumber = labelByNumber(idToLabel);
  forEachNumericRun(values, (value, runStart, runEnd) => {
    const label = byNumber.get(value);
    if (label !== undefined) labels.fill(label, runStart, runEnd);
  });
  return labels;
}

function labelizeUint64Slice(
  values: BigUint64Array,
  idToLabel: ReadonlyMap<bigint, number>,
): Uint8Array {
  const labels = new Uint8Array(values.length);
  forEachUint64Run(values, (low, high, runStart, runEnd) => {
    if (low === 0 && high === 0) return;
    const label = idToLabel.get(joinUint64(low, high));
    if (label !== undefined) labels.fill(label, runStart, runEnd);
  });
  return labels;
}

/** Fallback for plain arrays (tests, callers without a typed array). */
function labelizeAnySlice(
  values: ArrayLike<number | bigint>,
  idToLabel: ReadonlyMap<bigint, number>,
): Uint8Array {
  const labels = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    const id = typeof raw === "bigint" ? raw : BigInt(raw);
    const label = idToLabel.get(id);
    if (label !== undefined) labels[i] = label;
  }
  return labels;
}

/**
 * Call `visit` once per run of equal consecutive values, with the run's voxel
 * range `[runStart, runEnd)`. Segment masks are mostly long runs, so the
 * per-run work (a map lookup) is paid a few times per row instead of per voxel.
 */
function forEachNumericRun(
  values: ArrayLike<number>,
  visit: (value: number, runStart: number, runEnd: number) => void,
): void {
  // Hot path: one pass over every voxel of the region slice (TM-518 benchmark).
  const voxelCount = values.length;
  let runStart = 0;
  while (runStart < voxelCount) {
    const value = values[runStart];
    let runEnd = runStart + 1;
    while (runEnd < voxelCount && values[runEnd] === value) runEnd++;
    visit(value, runStart, runEnd);
    runStart = runEnd;
  }
}

/**
 * {@link forEachNumericRun} for `uint64` voxels, compared as their two 32-bit
 * halves through a `Uint32Array` view — no `bigint` is created per voxel.
 * Little-endian, like every platform the viewer runs on.
 */
function forEachUint64Run(
  values: BigUint64Array,
  visit: (low: number, high: number, runStart: number, runEnd: number) => void,
): void {
  // Hot path: one pass over every voxel of the region slice (TM-518 benchmark).
  const halves = new Uint32Array(
    values.buffer,
    values.byteOffset,
    values.length * 2,
  );
  const voxelCount = values.length;
  let runStart = 0;
  while (runStart < voxelCount) {
    const low = halves[2 * runStart];
    const high = halves[2 * runStart + 1];
    let runEnd = runStart + 1;
    while (
      runEnd < voxelCount &&
      halves[2 * runEnd] === low &&
      halves[2 * runEnd + 1] === high
    ) {
      runEnd++;
    }
    visit(low, high, runStart, runEnd);
    runStart = runEnd;
  }
}

function joinUint64(low: number, high: number): bigint {
  return (BigInt(high) << 32n) | BigInt(low);
}

/** `labelToId` as a dense table indexed by the `uint8` label (label 0 is never known). */
function idByLabelTable(
  labelToId: ReadonlyMap<number, bigint>,
): (bigint | undefined)[] {
  const table = new Array<bigint | undefined>(MAX_TRACKED_SEGMENTS + 1).fill(
    undefined,
  );
  for (const [label, id] of labelToId) {
    if (label > 0 && label <= MAX_TRACKED_SEGMENTS) table[label] = id;
  }
  return table;
}
