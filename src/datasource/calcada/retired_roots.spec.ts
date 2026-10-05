import { describe, expect, it } from "vitest";
import { RetiredRoots } from "#src/datasource/calcada/retired_roots.js";

describe("RetiredRoots", () => {
  it("brings back the roots an undone accept had retired", () => {
    const retired = new RetiredRoots();
    retired.retireAccept([1n, 2n]);
    retired.retireAccept([3n, 4n]);
    retired.undoAccept();
    expect([3n, 4n].map((id) => retired.has(id))).toEqual([false, false]);
    expect([1n, 2n].map((id) => retired.has(id))).toEqual([true, true]);
  });

  it("keeps what other edits retired", () => {
    const retired = new RetiredRoots();
    retired.retire([7n]);
    retired.retireAccept([1n, 2n]);
    retired.undoAccept();
    expect(retired.has(7n)).toBe(true);
  });

  it("forgets everything on clear", () => {
    const retired = new RetiredRoots();
    retired.retireAccept([1n]);
    retired.clear();
    retired.undoAccept();
    expect(retired.has(1n)).toBe(false);
  });
});
