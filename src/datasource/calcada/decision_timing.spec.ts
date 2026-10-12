import { describe, expect, it } from "vitest";
import { DecisionClock } from "#src/datasource/calcada/decision_timing.js";

function clockAt(start = 0) {
  let now = start;
  const clock = new DecisionClock(() => now, "session-1");
  return {
    clock,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("DecisionClock", () => {
  it("measures thinking from the candidate appearing and waiting from the previous action", () => {
    const { clock, advance } = clockAt();
    clock.markAction();
    advance(400);
    clock.markShown(1n);
    advance(2500);
    expect(clock.decide()).toEqual({
      thinkMs: 2500,
      waitMs: 400,
      sessionId: "session-1",
    });
  });

  // showCurrent re-runs for the same candidate on filter edits, graph
  // refreshes and edits made with other tools; none of that is a new question.
  it("keeps the first appearance when the same candidate is shown again", () => {
    const { clock, advance } = clockAt();
    clock.markShown(1n);
    advance(1000);
    clock.markShown(1n);
    advance(1000);
    expect(clock.decide().thinkMs).toBe(2000);
  });

  it("measures the next candidate's wait from the decision", () => {
    const { clock, advance } = clockAt();
    clock.markShown(1n);
    advance(1000);
    clock.decide();
    advance(1800);
    clock.markShown(2n);
    advance(300);
    expect(clock.decide()).toMatchObject({ thinkMs: 300, waitMs: 1800 });
  });

  it("does not count time the tab spent hidden as thinking", () => {
    const { clock, advance } = clockAt();
    clock.markShown(1n);
    advance(1000);
    clock.setHidden(true);
    advance(60_000);
    clock.setHidden(false);
    advance(500);
    expect(clock.decide().thinkMs).toBe(1500);
  });

  it("does not count hiding that was already under way when the candidate appeared", () => {
    const { clock, advance } = clockAt();
    clock.setHidden(true);
    advance(5000);
    clock.markShown(1n);
    advance(10_000);
    clock.setHidden(false);
    advance(700);
    expect(clock.decide().thinkMs).toBe(700);
  });

  it("counts a decision made while still hidden up to the moment of hiding", () => {
    const { clock, advance } = clockAt();
    clock.markShown(1n);
    advance(900);
    clock.setHidden(true);
    advance(4000);
    expect(clock.decide().thinkMs).toBe(900);
  });

  // An undo re-offers the accepted candidate, and a failed merge leaves it
  // current for a retry; either way it is asked again from that moment.
  it("restarts the clock when a decided candidate is shown again", () => {
    const { clock, advance } = clockAt();
    clock.markShown(1n);
    advance(1000);
    clock.decide();
    advance(4000);
    clock.markShown(1n);
    advance(600);
    expect(clock.decide()).toMatchObject({ thinkMs: 600, waitMs: 4000 });
  });

  it("rounds to whole milliseconds", () => {
    const { clock, advance } = clockAt();
    clock.markShown(1n);
    advance(1234.6);
    expect(clock.decide().thinkMs).toBe(1235);
  });
});
