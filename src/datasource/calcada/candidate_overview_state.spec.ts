import { describe, expect, it } from "vitest";
import {
  CalcadaOverviewState,
  SCORING_SEGMENT_STATUS,
  splitDetectionStatus,
  toggleSplitDetection,
} from "#src/datasource/calcada/candidate_overview_state.js";

describe("CalcadaOverviewState", () => {
  it("keeps detection on in the link", () => {
    const state = new CalcadaOverviewState();
    state.active.value = true;
    const restored = new CalcadaOverviewState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.active.value).toBe(true);
  });

  it("writes nothing when off", () => {
    expect(new CalcadaOverviewState().toJSON()).toBeUndefined();
  });
});

describe("how flagged pieces are shown", () => {
  it("shows red points by default and round-trips coloured pieces", () => {
    const state = new CalcadaOverviewState();
    expect(state.display.value).toBe("points");
    state.active.value = true;
    expect(JSON.stringify(state.toJSON())).not.toContain("show");
    state.display.value = "pieces";
    const restored = new CalcadaOverviewState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.display.value).toBe("pieces");
  });

  it("ignores a way of showing it does not know", () => {
    const state = new CalcadaOverviewState();
    state.restoreState({ active: true, show: "sparkles" });
    expect(state.display.value).toBe("points");
  });
});

describe("toggleSplitDetection", () => {
  it("switches detection on and off outside a trace", () => {
    expect(
      toggleSplitDetection({ tracing: false, active: false, onMain: false }),
    ).toBe(true);
    expect(
      toggleSplitDetection({ tracing: false, active: true, onMain: false }),
    ).toBe(false);
  });

  it("leaves a running trace alone", () => {
    expect(
      toggleSplitDetection({ tracing: true, active: false, onMain: false }),
    ).toBe(false);
  });

  it("does not start detection on main", () => {
    expect(
      toggleSplitDetection({ tracing: false, active: false, onMain: true }),
    ).toBe(false);
  });
});

describe("splitDetectionStatus", () => {
  it("counts flagged pieces once the filter has all it needs", () => {
    expect(
      splitDetectionStatus({
        graphPending: false,
        flagged: 2,
        total: 2000,
        withSemantics: 0,
      }),
    ).toBe("2 of 2,000 pieces flagged · 0 candidates with semantics");
  });

  it("says it is still scoring while the piece graph loads", () => {
    expect(
      splitDetectionStatus({
        graphPending: true,
        flagged: 0,
        total: 2000,
        withSemantics: 0,
      }),
    ).toBe(SCORING_SEGMENT_STATUS);
  });
});
