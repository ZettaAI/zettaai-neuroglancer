import { describe, expect, it } from "vitest";
import { isStaleRoot } from "#src/datasource/calcada/root_resolution.js";

describe("isStaleRoot", () => {
  it("flags a root that was just retired by the edit", () => {
    expect(isStaleRoot(5n, new Set([5n, 6n]))).toBe(true);
  });
  it("does not flag a root that was not part of the edit", () => {
    expect(isStaleRoot(9n, new Set([5n, 6n]))).toBe(false);
  });
});
