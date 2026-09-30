import { describe, expect, it } from "vitest";
import { CalcadaOverviewState } from "#src/datasource/calcada/candidate_overview_state.js";

describe("CalcadaOverviewState", () => {
  it("keeps the chosen segment in the link", () => {
    const state = new CalcadaOverviewState();
    state.active.value = true;
    state.seedPiece.value = 72057594037927937n;
    state.seedPoint.value = Float32Array.of(1, 2, 3);
    const restored = new CalcadaOverviewState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.active.value).toBe(true);
    expect(restored.seedPiece.value).toBe(72057594037927937n);
    expect(Array.from(restored.seedPoint.value!)).toEqual([1, 2, 3]);
  });

  it("writes nothing when off and without a segment", () => {
    expect(new CalcadaOverviewState().toJSON()).toBeUndefined();
  });
});
