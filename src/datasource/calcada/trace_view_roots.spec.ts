import { describe, expect, it } from "vitest";
import {
  rootsKeptOnExit,
  rootsShownWhileTracing,
} from "#src/datasource/calcada/trace_view_roots.js";

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

describe("rootsShownWhileTracing", () => {
  it("shows the seed and the candidate only, by default", () => {
    expect(
      rootsShownWhileTracing(1n, 2n, {
        splitParts: [5n, 6n],
        keepSplitParts: false,
        retired: new Set(),
      }),
    ).toEqual([1n, 2n]);
  });

  it("keeps the live parts of a split on screen when asked", () => {
    expect(
      rootsShownWhileTracing(1n, 2n, {
        splitParts: [5n, 6n, 1n],
        keepSplitParts: true,
        retired: new Set([6n]),
      }),
    ).toEqual([1n, 2n, 5n]);
  });

  it("needs no candidate", () => {
    expect(
      rootsShownWhileTracing(1n, undefined, {
        splitParts: [5n],
        keepSplitParts: true,
        retired: new Set(),
      }),
    ).toEqual([1n, 5n]);
  });
});
