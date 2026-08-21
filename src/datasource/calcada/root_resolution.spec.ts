import { describe, expect, it } from "vitest";
import {
  classifyCandidateEdit,
  isStaleRoot,
} from "#src/datasource/calcada/root_resolution.js";

describe("isStaleRoot", () => {
  it("flags a root that was just retired by the edit", () => {
    expect(isStaleRoot(5n, new Set([5n, 6n]))).toBe(true);
  });
  it("does not flag a root that was not part of the edit", () => {
    expect(isStaleRoot(9n, new Set([5n, 6n]))).toBe(false);
  });
});

describe("classifyCandidateEdit", () => {
  it("classifies as absorbed when the candidate's new root equals the seed's new root", () => {
    expect(classifyCandidateEdit(false, 10n, 10n)).toBe("absorbed");
  });
  it("classifies as rerooted when only the partner root changed", () => {
    expect(classifyCandidateEdit(false, 10n, 20n)).toBe("rerooted");
  });
  it("classifies as unaffected when the seed itself was re-rooted", () => {
    expect(classifyCandidateEdit(true, 10n, 20n)).toBe("unaffected");
  });
});
