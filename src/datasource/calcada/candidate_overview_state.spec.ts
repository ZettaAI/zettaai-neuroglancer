import { describe, expect, it } from "vitest";
import { CalcadaOverviewState } from "#src/datasource/calcada/candidate_overview_state.js";

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
