import { describe, expect, it } from "vitest";
import {
  TRACE_SEED_COLOR_PACKED,
  TRACE_CANDIDATE_COLOR_PACKED,
  TRACE_SEED_DIM_COLOR_PACKED,
} from "#src/datasource/calcada/role_colors.js";

describe("role colors", () => {
  it("packs the seed color with full alpha", () => {
    expect((TRACE_SEED_COLOR_PACKED >> 24n) & 0xffn).toBe(0xffn);
  });
  it("packs the candidate color distinctly from the seed color", () => {
    expect(TRACE_CANDIDATE_COLOR_PACKED).not.toBe(TRACE_SEED_COLOR_PACKED);
  });
  it("packs the dim seed color with reduced alpha", () => {
    const dimAlpha = (TRACE_SEED_DIM_COLOR_PACKED >> 24n) & 0xffn;
    expect(dimAlpha).toBeLessThan(0x30n);
    expect(dimAlpha).toBeGreaterThan(0n);
  });
});
