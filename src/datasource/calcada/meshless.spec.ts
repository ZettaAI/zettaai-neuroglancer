import { describe, expect, it } from "vitest";
import {
  meshlessFragmentKey,
  updateMeshlessFragments,
} from "#src/datasource/calcada/meshless.js";

describe("updateMeshlessFragments", () => {
  it("keys bare and suffixed ids the same way", () => {
    expect(meshlessFragmentKey("12345")).toBe("12345:0");
    expect(meshlessFragmentKey("12345:0")).toBe("12345:0");
    expect(meshlessFragmentKey(12345)).toBe("12345:0");
  });

  it("marks pieces the manifest lists as missing", () => {
    const meshless = new Set<string>();
    updateMeshlessFragments(meshless, ["1:0"], ["2", "3"]);
    expect([...meshless].sort()).toEqual(["2:0", "3:0"]);
  });

  it("unmarks a piece once a later manifest lists its mesh", () => {
    const meshless = new Set<string>();
    updateMeshlessFragments(meshless, [], ["7", "8"]);
    updateMeshlessFragments(meshless, ["7:0"], ["8"]);
    expect([...meshless]).toEqual(["8:0"]);
    updateMeshlessFragments(meshless, ["8"], []);
    expect(meshless.size).toBe(0);
  });

  it("ignores a manifest without fragment lists", () => {
    const meshless = new Set(["5:0"]);
    updateMeshlessFragments(meshless, undefined, null);
    expect([...meshless]).toEqual(["5:0"]);
  });
});
