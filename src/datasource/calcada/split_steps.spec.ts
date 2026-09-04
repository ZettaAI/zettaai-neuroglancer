import { describe, expect, it } from "vitest";
import {
  SPLIT_STAGES,
  stageAction,
  stageSummary,
  stoppableStages,
} from "#src/datasource/calcada/split_steps.js";

describe("SPLIT_STAGES", () => {
  it("names the three waves, all of them stopping points", () => {
    expect(SPLIT_STAGES).toHaveLength(3);
    expect(stoppableStages()).toHaveLength(3);
    expect(SPLIT_STAGES.map((s) => s.wave)).toEqual([1, 2, 3]);
  });

  // Each wave runs once now, so nothing reports a round and the panel never
  // has to explain a button firing several times.
  it("marks no wave as repeating", () => {
    expect(SPLIT_STAGES.some((s) => s.repeats)).toBe(false);
  });
});

describe("stageAction", () => {
  it("treats every wave as a step forward before anything has run", () => {
    expect(stageAction(1, 0)).toBe("advance");
    expect(stageAction(3, 0)).toBe("advance");
  });

  it("calls a wave behind the one reached a rewind", () => {
    expect(stageAction(1, 3)).toBe("rewind");
  });

  it("calls the wave reached the current one", () => {
    expect(stageAction(2, 2)).toBe("current");
  });

  it("calls a wave past the one reached a step forward", () => {
    expect(stageAction(3, 2)).toBe("advance");
  });
});

describe("stageSummary", () => {
  it("names a wave without a round, since none repeats", () => {
    expect(stageSummary(1, 0)).toBe("Points");
    expect(stageSummary(3, 2)).toBe("Cut");
  });

  it("falls back to the number for a wave it does not know", () => {
    expect(stageSummary(9, 0)).toBe("Stage 9");
  });
});
