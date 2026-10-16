import { describe, expect, it } from "vitest";
import { sectionSpanInUnits } from "#src/datasource/calcada/realign/realign_tools.js";

describe("sectionSpanInUnits", () => {
  it("spans one graph section when annotation units are graph voxels", () => {
    expect(sectionSpanInUnits(3103.5, 45, 45)).toEqual([3103, 3104]);
  });

  it("converts through nanometres when the units differ", () => {
    const [lo, hi] = sectionSpanInUnits(126, 10, 40);
    expect(lo).toBeCloseTo(124);
    expect(hi).toBeCloseTo(128);
  });
});
