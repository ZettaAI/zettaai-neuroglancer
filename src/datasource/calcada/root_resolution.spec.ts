import { describe, expect, it } from "vitest";
import {
  classifyCandidateEdit,
  componentsWithCarvedParents,
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
  it("classifies as superseded when the partner's piece was cut in two", () => {
    expect(classifyCandidateEdit(false, 10n, 0n)).toBe("superseded");
  });
  it("classifies as superseded when the seed's own piece was cut in two", () => {
    expect(classifyCandidateEdit(false, 0n, 20n)).toBe("superseded");
  });
  it("does not read two cut pieces as one absorbed candidate", () => {
    expect(classifyCandidateEdit(false, 0n, 0n)).toBe("superseded");
  });
});

describe("componentsWithCarvedParents", () => {
  // A carve that leaves the segment whole puts both halves in the one root, so
  // the parent names that root and nothing else.
  it("carries the parent into the root that took both of its halves", () => {
    const { components, ambiguous } = componentsWithCarvedParents(
      [[1n, 11n, 12n, 3n]],
      [{ old: 2n, blue: 11n, red: 12n }],
    );
    expect(components).toEqual([[1n, 11n, 12n, 3n, 2n]]);
    expect(ambiguous).toEqual([]);
  });

  // Half the parent's voxels belong to each root, so naming either would paint
  // the other half wrong. Re-reading the voxels is the only way out.
  it("reports a parent whose halves went to different roots instead of guessing", () => {
    const { components, ambiguous } = componentsWithCarvedParents(
      [
        [1n, 11n],
        [12n, 3n],
      ],
      [{ old: 2n, blue: 11n, red: 12n }],
    );
    expect(components).toEqual([
      [1n, 11n],
      [12n, 3n],
    ]);
    expect(ambiguous).toEqual([2n]);
  });

  // One split routinely carves several pieces, and the two cases mix freely.
  it("decides each carved piece on its own", () => {
    const { components, ambiguous } = componentsWithCarvedParents(
      [[11n, 12n, 21n], [22n]],
      [
        { old: 1n, blue: 11n, red: 12n },
        { old: 2n, blue: 21n, red: 22n },
      ],
    );
    expect(components).toEqual([[11n, 12n, 21n, 1n], [22n]]);
    expect(ambiguous).toEqual([2n]);
  });

  // A half the response never mentions cannot place its parent.
  it("treats an unplaceable half as ambiguous", () => {
    const { ambiguous } = componentsWithCarvedParents(
      [[11n]],
      [{ old: 1n, blue: 11n, red: 99n }],
    );
    expect(ambiguous).toEqual([1n]);
  });

  // A split with no carved pieces is the multicut case: nothing to place.
  it("leaves the components alone when nothing was carved", () => {
    const { components, ambiguous } = componentsWithCarvedParents(
      [[1n], [2n]],
      [],
    );
    expect(components).toEqual([[1n], [2n]]);
    expect(ambiguous).toEqual([]);
  });
});
