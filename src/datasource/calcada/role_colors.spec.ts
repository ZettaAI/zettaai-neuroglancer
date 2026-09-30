import { describe, expect, it } from "vitest";
import {
  interceptedRemovals,
  TRACE_SEED_COLOR_PACKED,
  TRACE_CANDIDATE_COLOR_PACKED,
  TRACE_SEED_DIM_COLOR_PACKED,
} from "#src/datasource/calcada/role_colors.js";

describe("role colors", () => {
  it("packs the seed color with no alpha of its own", () => {
    // Zero means "leave the layer's alpha alone": a seed is recolored, not
    // made more opaque than the segments around it.
    expect((TRACE_SEED_COLOR_PACKED >> 24n) & 0xffn).toBe(0n);
    expect((TRACE_CANDIDATE_COLOR_PACKED >> 24n) & 0xffn).toBe(0n);
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

describe("interceptedRemovals", () => {
  it("keeps only ids that are seed or candidate roots", () => {
    const roles = new Set([1n, 2n]);
    expect(interceptedRemovals([1n, 3n], roles)).toEqual([1n]);
  });
  it("returns nothing when no removed id is a role root", () => {
    const roles = new Set([1n, 2n]);
    expect(interceptedRemovals([3n, 4n], roles)).toEqual([]);
  });
});
