import { describe, expect, it } from "vitest";
import {
  SPLIT_STAGES,
  stageAction,
  stageSummary,
  stoppableStages,
} from "#src/datasource/calcada/split_steps.js";

describe("SPLIT_STAGES", () => {
  // Sergiy asked for four buttons; there are five stages and the fourth can
  // fire several times. The model has to say so or the panel misleads.
  it("names five stages and marks the repeating one", () => {
    expect(SPLIT_STAGES).toHaveLength(5);
    expect(SPLIT_STAGES.filter((s) => s.repeats).map((s) => s.wave)).toEqual([
      4,
    ]);
  });

  // The carve is not a stopping point: every run performs it, and the server
  // refuses a stop_after below the first cut.
  it("offers only the cut stages as stopping points", () => {
    expect(stoppableStages().map((s) => s.wave)).toEqual([2, 3, 4, 5]);
  });

  it("numbers the stages the way the server does", () => {
    expect(SPLIT_STAGES.map((s) => s.wave)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("stageAction", () => {
  it("treats every stage as a step forward before anything has run", () => {
    expect(stageAction(2, 0)).toBe("advance");
    expect(stageAction(5, 0)).toBe("advance");
  });

  it("calls a stage behind the one reached a rewind", () => {
    expect(stageAction(2, 4)).toBe("rewind");
  });

  it("calls the stage reached the current one", () => {
    expect(stageAction(3, 3)).toBe("current");
  });

  it("calls a stage past the one reached a step forward", () => {
    expect(stageAction(5, 3)).toBe("advance");
  });
});

describe("stageSummary", () => {
  // "Recover" firing three times otherwise looks like the panel is stuck.
  it("reports the round for the stage that repeats", () => {
    expect(stageSummary(4, 0)).toBe("Recover");
    expect(stageSummary(4, 2)).toBe("Recover (round 3)");
  });

  it("leaves a stage that runs once without a round", () => {
    expect(stageSummary(3, 2)).toBe("Pinned");
  });

  it("falls back to the number for a stage it does not know", () => {
    expect(stageSummary(9, 0)).toBe("Stage 9");
  });
});
