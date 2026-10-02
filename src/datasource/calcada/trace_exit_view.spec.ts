import { describe, expect, it } from "vitest";
import { rootsKeptOnExit } from "#src/datasource/calcada/trace_exit_view.js";

describe("rootsKeptOnExit", () => {
  it("drops retired roots and the candidate under review", () => {
    expect(
      rootsKeptOnExit([1n, 2n, 3n], {
        retired: new Set([2n]),
        candidateRoot: 3n,
        seedRoot: 1n,
      }),
    ).toEqual(new Set([1n]));
  });

  // Accept retires the seed it merged; undoing that accept brings the very
  // same root back as the seed. Leaving then must not hide it.
  it("keeps the seed even when an undone accept had retired it", () => {
    expect(
      rootsKeptOnExit([5n, 9n], {
        retired: new Set([5n]),
        candidateRoot: 9n,
        seedRoot: 5n,
      }),
    ).toEqual(new Set([5n]));
  });

  it("does not add a seed that is not on screen", () => {
    expect(
      rootsKeptOnExit([7n], {
        retired: new Set(),
        candidateRoot: undefined,
        seedRoot: 5n,
      }),
    ).toEqual(new Set([7n]));
  });
});
