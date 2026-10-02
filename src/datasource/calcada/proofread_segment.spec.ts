import { describe, expect, it } from "vitest";
import { ProofreadSegment } from "#src/datasource/calcada/proofread_segment.js";

describe("ProofreadSegment", () => {
  it("keeps the selected segment in the link", () => {
    const segment = new ProofreadSegment();
    segment.select(72057594037927937n, Float32Array.of(1, 2, 3));
    const restored = new ProofreadSegment();
    restored.restoreState(JSON.parse(JSON.stringify(segment.toJSON())));
    expect(restored.piece.value).toBe(72057594037927937n);
    expect(Array.from(restored.point.value!)).toEqual([1, 2, 3]);
  });

  it("writes nothing without a segment", () => {
    expect(new ProofreadSegment().toJSON()).toBeUndefined();
  });

  it("forgets the point with the piece", () => {
    const segment = new ProofreadSegment();
    segment.select(5n, Float32Array.of(1, 2, 3));
    segment.clear();
    expect(segment.piece.value).toBeUndefined();
    expect(segment.point.value).toBeUndefined();
  });

  it("announces a new selection once, with the point already in place", () => {
    const segment = new ProofreadSegment();
    const seen: Array<number[] | undefined> = [];
    segment.piece.changed.add(() =>
      seen.push(segment.point.value && Array.from(segment.point.value)),
    );
    segment.select(5n, Float32Array.of(4, 5, 6));
    expect(seen).toEqual([[4, 5, 6]]);
  });
});
