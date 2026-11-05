/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import {
  buildLabelMap,
  delabelizeMaskSlice,
  distinctNonZeroSegmentIds,
  protectSegmentVoxels,
  labelizeMaskSlice,
  MAX_TRACKED_SEGMENTS,
  TooManyTrackedSegmentsError,
} from "#src/editing/tool_runtimes/mask_label_codec.js";

describe("buildLabelMap", () => {
  it("numbers ids 1..N in first-seen order", () => {
    const { idToLabel, labelToId } = buildLabelMap([30n, 10n, 20n]);
    expect(idToLabel.get(30n)).toBe(1);
    expect(idToLabel.get(10n)).toBe(2);
    expect(idToLabel.get(20n)).toBe(3);
    expect(labelToId.get(1)).toBe(30n);
    expect(labelToId.get(2)).toBe(10n);
    expect(labelToId.get(3)).toBe(20n);
  });

  it("drops background (0n) and duplicate ids", () => {
    const { idToLabel } = buildLabelMap([0n, 5n, 5n, 7n, 0n]);
    expect(idToLabel.size).toBe(2);
    expect(idToLabel.get(5n)).toBe(1);
    expect(idToLabel.get(7n)).toBe(2);
  });

  it("accepts exactly 255 distinct ids", () => {
    const ids = Array.from({ length: MAX_TRACKED_SEGMENTS }, (_, i) =>
      BigInt(i + 1),
    );
    const { idToLabel } = buildLabelMap(ids);
    expect(idToLabel.size).toBe(255);
  });

  it("throws when more than 255 distinct ids are tracked", () => {
    const ids = Array.from({ length: 256 }, (_, i) => BigInt(i + 1));
    expect(() => buildLabelMap(ids)).toThrow(TooManyTrackedSegmentsError);
  });
});

describe("labelizeMaskSlice", () => {
  it("maps tracked ids to labels and everything else to 0 (bigint input)", () => {
    const { idToLabel } = buildLabelMap([100n, 200n]);
    const values = BigUint64Array.from([100n, 0n, 200n, 999n]);
    expect([...labelizeMaskSlice(values, idToLabel)]).toEqual([1, 0, 2, 0]);
  });

  it("widens numeric (uint32) values to bigint for the lookup", () => {
    const { idToLabel } = buildLabelMap([100n, 200n]);
    const values = Uint32Array.from([100, 200, 0, 200]);
    expect([...labelizeMaskSlice(values, idToLabel)]).toEqual([1, 2, 0, 2]);
  });
});

describe("labelizeMaskSlice runs and wide ids (TM-518)", () => {
  /** Reference: the per-voxel lookup the fast paths must reproduce exactly. */
  function referenceLabels(
    values: ArrayLike<number | bigint>,
    idToLabel: ReadonlyMap<bigint, number>,
  ): number[] {
    return Array.from({ length: values.length }, (_, i) => {
      const raw = values[i];
      return idToLabel.get(typeof raw === "bigint" ? raw : BigInt(raw)) ?? 0;
    });
  }

  it("matches ids that differ only in their high 32 bits", () => {
    const low = 5n;
    const high = (1n << 32n) | 5n;
    const { idToLabel } = buildLabelMap([high]);
    const values = BigUint64Array.from([low, high, high, low, 0n, high]);
    expect([...labelizeMaskSlice(values, idToLabel)]).toEqual([
      0, 1, 1, 0, 0, 1,
    ]);
  });

  it("labels runs of equal ids exactly like the per-voxel reference", () => {
    const ids = [7n, 1n << 40n, 0n, 9n, (1n << 63n) + 3n];
    const { idToLabel } = buildLabelMap([1n << 40n, 9n, (1n << 63n) + 3n]);
    const values = BigUint64Array.from(
      Array.from(
        { length: 200 },
        (_, i) => ids[Math.floor(i / 7) % ids.length],
      ),
    );
    expect([...labelizeMaskSlice(values, idToLabel)]).toEqual(
      referenceLabels(values, idToLabel),
    );
  });

  it("reads a BigUint64Array view at a non-zero byte offset", () => {
    const backing = BigUint64Array.from([100n, 200n, 100n, 300n]);
    const view = new BigUint64Array(backing.buffer, 8, 3); // [200, 100, 300]
    const { idToLabel } = buildLabelMap([100n, 300n]);
    expect([...labelizeMaskSlice(view, idToLabel)]).toEqual([0, 1, 2]);
  });

  it("labels uint16 and uint8 masks", () => {
    const { idToLabel } = buildLabelMap([3n, 40000n]);
    expect([
      ...labelizeMaskSlice(Uint16Array.from([40000, 3, 3, 2]), idToLabel),
    ]).toEqual([2, 1, 1, 0]);
    expect([
      ...labelizeMaskSlice(Uint8Array.from([3, 3, 0, 4]), idToLabel),
    ]).toEqual([1, 1, 0, 0]);
  });

  it("labels a plain array (no typed array)", () => {
    const { idToLabel } = buildLabelMap([100n]);
    expect([...labelizeMaskSlice([100, 100n, 5], idToLabel)]).toEqual([
      1, 1, 0,
    ]);
  });
});

describe("distinctNonZeroSegmentIds (TM-518)", () => {
  it("lists uint64 ids once each, in first-seen order, without 0", () => {
    const wide = (1n << 32n) | 7n;
    const values = BigUint64Array.from([0n, 7n, 7n, wide, 0n, 7n, 9n, wide]);
    expect(distinctNonZeroSegmentIds(values)).toEqual([7n, wide, 9n]);
  });

  it("lists numeric ids as bigint", () => {
    const values = Uint32Array.from([0, 4294967295, 12, 12, 0]);
    expect(distinctNonZeroSegmentIds(values)).toEqual([4294967295n, 12n]);
  });

  it("returns nothing for an empty slice", () => {
    expect(distinctNonZeroSegmentIds(BigUint64Array.from([0n, 0n]))).toEqual(
      [],
    );
  });
});

describe("delabelizeMaskSlice", () => {
  it("decodes labels to ids and gates the write mask", () => {
    const { labelToId } = buildLabelMap([100n, 200n]);
    const { ids, valueMask } = delabelizeMaskSlice([1, 0, 2, 1], labelToId);
    expect([...ids]).toEqual([100n, 0n, 200n, 100n]);
    expect([...valueMask]).toEqual([1, 0, 1, 1]);
  });

  it("leaves unknown labels unwritten (id 0n, gate 0)", () => {
    const { labelToId } = buildLabelMap([100n]);
    const { ids, valueMask } = delabelizeMaskSlice([9, 1], labelToId);
    expect([...ids]).toEqual([0n, 100n]);
    expect([...valueMask]).toEqual([0, 1]);
  });

  it("decodes runs and ids wider than 32 bits", () => {
    const wide = (1n << 50n) + 1n;
    const { labelToId } = buildLabelMap([wide, 3n]);
    const { ids, valueMask } = delabelizeMaskSlice(
      Uint8Array.from([1, 1, 1, 0, 0, 2, 2, 1]),
      labelToId,
    );
    expect([...ids]).toEqual([wide, wide, wide, 0n, 0n, 3n, 3n, wide]);
    expect([...valueMask]).toEqual([1, 1, 1, 0, 0, 1, 1, 1]);
  });

  it("round-trips through labelize when every voxel is tracked", () => {
    const { idToLabel, labelToId } = buildLabelMap([7n, 8n, 9n]);
    const original = BigUint64Array.from([7n, 8n, 9n, 8n, 7n]);
    const labels = labelizeMaskSlice(original, idToLabel);
    const { ids } = delabelizeMaskSlice(labels, labelToId);
    expect([...ids]).toEqual([...original]);
  });
});

describe("protectSegmentVoxels (TM-518)", () => {
  it("clears the write gate over protected uint64 segments", () => {
    const wide = (1n << 40n) + 2n;
    const valueMask = Uint8Array.from([1, 1, 1, 1, 0, 1]);
    const existing = BigUint64Array.from([0n, wide, wide, 7n, wide, 2n]);
    protectSegmentVoxels(valueMask, existing, [wide]);
    // `2n` shares the low 32 bits with `wide` but is a different segment.
    expect([...valueMask]).toEqual([1, 0, 0, 1, 0, 1]);
  });

  it("clears the write gate over protected numeric segments", () => {
    const valueMask = Uint8Array.from([1, 1, 1, 1]);
    protectSegmentVoxels(valueMask, Uint32Array.from([5, 6, 5, 0]), [5n]);
    expect([...valueMask]).toEqual([0, 1, 0, 1]);
  });

  it("leaves the gate alone with nothing to protect", () => {
    const valueMask = Uint8Array.from([1, 1]);
    protectSegmentVoxels(valueMask, Uint32Array.from([5, 6]), []);
    expect([...valueMask]).toEqual([1, 1]);
  });
});
