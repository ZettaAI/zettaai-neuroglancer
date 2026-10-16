import { describe, expect, it } from "vitest";
import { boxSpanInUnits } from "#src/datasource/calcada/realign/realign_tools.js";

describe("boxSpanInUnits", () => {
  it("covers the clicked section and the one below it", () => {
    expect(boxSpanInUnits(3104.5, 45, 45, -1)).toEqual([3103, 3105]);
  });

  it("reaches up to a reference above, sections between included", () => {
    expect(boxSpanInUnits(3104.5, 45, 45, 2)).toEqual([3104, 3107]);
  });

  it("converts through nanometres when the units differ", () => {
    const [lo, hi] = boxSpanInUnits(126, 10, 40, -1);
    expect(lo).toBeCloseTo(120);
    expect(hi).toBeCloseTo(128);
  });
});
