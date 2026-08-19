import { describe, expect, it } from "vitest";
import { selectLodForPieceCount } from "#src/datasource/calcada/lod_selection.js";

describe("selectLodForPieceCount", () => {
  it("picks the finest LOD for small segments", () => {
    expect(selectLodForPieceCount(10, 4)).toBe(0);
  });
  it("picks a coarser LOD as piece count grows", () => {
    const small = selectLodForPieceCount(60, 4);
    const large = selectLodForPieceCount(600, 4);
    expect(large).toBeGreaterThan(small);
  });
  it("never exceeds the manifest's available LOD count", () => {
    expect(selectLodForPieceCount(1_000_000, 3)).toBe(2);
  });
  it("returns 0 when the manifest has only one LOD", () => {
    expect(selectLodForPieceCount(1_000_000, 1)).toBe(0);
  });
});
