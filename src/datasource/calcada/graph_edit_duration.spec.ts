import { afterEach, describe, expect, it, vi } from "vitest";
import { editTookLabel } from "#src/datasource/calcada/graph_edit_duration.js";

describe("editTookLabel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the edit and how long it took, in seconds", () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    vi.advanceTimersByTime(1310);
    expect(editTookLabel("carve", startedAt)).toBe("carve took 1.31 sec");
  });

  // A fast edit still reads in seconds rather than switching units, so the
  // numbers in two messages can be compared at a glance.
  it("keeps seconds and two decimals for a fast edit", () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    vi.advanceTimersByTime(420);
    expect(editTookLabel("merge", startedAt)).toBe("merge took 0.42 sec");
  });
});
