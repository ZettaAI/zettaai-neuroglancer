import { describe, expect, it } from "vitest";
import { globalSectionSpan } from "#src/datasource/calcada/realign/realign_tools.js";

const NANOMETRE = 1e-9;

describe("globalSectionSpan", () => {
  it("spans one graph section when global and graph z units match", () => {
    expect(globalSectionSpan(3103.5, 45 * NANOMETRE, 45)).toEqual([3103, 3104]);
  });

  it("converts through nanometres when the units differ", () => {
    const [lo, hi] = globalSectionSpan(31.5 * 4, 10 * NANOMETRE, 40);
    expect(lo).toBeCloseTo(124);
    expect(hi).toBeCloseTo(128);
  });
});
