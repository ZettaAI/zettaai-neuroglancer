import { describe, expect, it } from "vitest";
import { FragmentSpatialIndex } from "#src/datasource/calcada/fragment_spatial.js";
import type { FragmentSpatialHint } from "#src/mesh/backend.js";
import { getFrustrumPlanes, mat4, vec3 } from "#src/util/geom.js";

// A 2000x2000x2000 nm box centered at the origin, viewed head-on with the
// focus at the origin, gives simple, hand-checkable in/out-of-frustum math.
function makeHint(): FragmentSpatialHint {
  const mvp = mat4.ortho(mat4.create(), -1000, 1000, -1000, 1000, -1000, 1000);
  const clippingPlanes = getFrustrumPlanes(new Float32Array(24), mvp);
  return { clippingPlanes, focusModel: vec3.fromValues(0, 0, 0) };
}

describe("FragmentSpatialIndex", () => {
  it("orders known in-frustum pieces by distance to the focus", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["near:0", "far:0"], [10, 0, 0, 50, 0, 0], [5, 5]);
    index.updateHint(makeHint());
    expect(index.score("near:0")).toBeLessThan(index.score("far:0"));
    expect(index.compare("near:0", "far:0")).toBeLessThan(0);
  });

  it("scores an out-of-frustum piece after an unknown-bounds piece", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      ["unknown:0", "outside:0"],
      [0, 0, 0, 10000, 0, 0],
      [-1, 1],
    );
    index.updateHint(makeHint());
    expect(index.score("unknown:0")).toBeLessThan(index.score("outside:0"));
  });

  it("scores unknown-bounds pieces after every known in-frustum piece", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      ["near:0", "far:0", "unknown:0"],
      [10, 0, 0, 50, 0, 0, 0, 0, 0],
      [5, 5, -1],
    );
    index.updateHint(makeHint());
    expect(index.score("far:0")).toBeLessThan(index.score("unknown:0"));
    expect(index.score("near:0")).toBeLessThan(index.score("unknown:0"));
  });

  it("updateHint(null) makes compare return 0 for all pairs", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      ["near:0", "far:0", "unknown:0", "outside:0"],
      [10, 0, 0, 50, 0, 0, 0, 0, 0, 5000, 0, 0],
      [5, 5, -1, 5],
    );
    index.updateHint(makeHint());
    index.updateHint(null);
    expect(index.compare("near:0", "far:0")).toBe(0);
    expect(index.compare("outside:0", "unknown:0")).toBe(0);
    expect(index.score("near:0")).toBe(0);
    expect(index.score("outside:0")).toBe(0);
  });

  it("keeps priorityBias within [-1, 0] and monotone in distance", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      ["near:0", "far:0", "unknown:0", "outside:0"],
      [10, 0, 0, 50, 0, 0, 0, 0, 0, 10000, 0, 0],
      [5, 5, -1, 1],
    );
    index.updateHint(makeHint());
    const biasNear = index.priorityBias("near:0");
    const biasFar = index.priorityBias("far:0");
    const biasUnknown = index.priorityBias("unknown:0");
    const biasOutside = index.priorityBias("outside:0");
    for (const bias of [biasNear, biasFar, biasUnknown, biasOutside]) {
      expect(bias).toBeGreaterThanOrEqual(-1);
      expect(bias).toBeLessThanOrEqual(0);
    }
    expect(biasNear).toBeGreaterThan(biasFar);
    expect(biasFar).toBeGreaterThan(biasUnknown);
    expect(biasUnknown).toBeGreaterThan(biasOutside);
  });

  it("merges spheres across multiple setFromManifest calls instead of replacing them", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["near:0"], [10, 0, 0], [5]);
    index.setFromManifest(["far:0"], [50, 0, 0], [5]);
    index.updateHint(makeHint());
    expect(index.score("near:0")).toBeLessThan(index.score("far:0"));
  });

  it("ignores frag_centers/frag_radii on length mismatch", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["near:0", "far:0"], [10, 0, 0], [5, 5]);
    index.updateHint(makeHint());
    // Both pieces fall back to unknown-bounds treatment since the malformed
    // manifest was ignored, so neither is scored as in-frustum.
    expect(index.score("near:0")).toBe(index.score("far:0"));
  });

  it("gives a fragment with no spatial data no priority penalty", () => {
    const index = new FragmentSpatialIndex();
    index.updateHint(makeHint());
    expect(index.priorityBias("never-seen:0")).toBe(0);
    expect(index.compare("never-seen:0", "also-never-seen:0")).toBe(0);
  });

  it("scores a never-seen fragment like an unknown-bounds one but with no bias penalty", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["unknown:0"], [0, 0, 0], [-1]);
    index.updateHint(makeHint());
    expect(index.compare("never-seen:0", "unknown:0")).toBe(0);
    expect(index.priorityBias("never-seen:0")).toBe(0);
    expect(index.priorityBias("unknown:0")).toBe(-0.75);
  });

  it("updateHint returns true when the hint is set or cleared and false when it is value-identical", () => {
    const index = new FragmentSpatialIndex();
    expect(index.updateHint(null)).toBe(false);
    expect(index.updateHint(makeHint())).toBe(true);
    expect(index.updateHint(makeHint())).toBe(false);
    expect(index.updateHint(null)).toBe(true);
    expect(index.updateHint(null)).toBe(false);
  });

  it("updateHint returns true when only the focus moves", () => {
    const index = new FragmentSpatialIndex();
    index.updateHint(makeHint());
    const movedFocus: FragmentSpatialHint = {
      clippingPlanes: makeHint().clippingPlanes,
      focusModel: vec3.fromValues(1, 0, 0),
    };
    expect(index.updateHint(movedFocus)).toBe(true);
  });

  it("does not rebuild the score cache when updateHint receives an unchanged hint", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["near:0"], [10, 0, 0], [5]);
    index.updateHint(makeHint());
    index.score("near:0"); // force the cache to fill
    const cacheBefore = (index as unknown as { scoreCache: unknown })
      .scoreCache;
    // A freshly-built hint with identical values, but a different object
    // identity, must not trigger a rebuild.
    index.updateHint(makeHint());
    const cacheAfter = (index as unknown as { scoreCache: unknown }).scoreCache;
    expect(cacheAfter).toBe(cacheBefore);
  });

  it("does rebuild the score cache when updateHint receives a changed hint", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["near:0"], [10, 0, 0], [5]);
    index.updateHint(makeHint());
    index.score("near:0");
    const cacheBefore = (index as unknown as { scoreCache: unknown })
      .scoreCache;
    index.updateHint({
      clippingPlanes: makeHint().clippingPlanes,
      focusModel: vec3.fromValues(1, 0, 0),
    });
    index.score("near:0"); // force the cache to refill
    const cacheAfter = (index as unknown as { scoreCache: unknown }).scoreCache;
    expect(cacheAfter).not.toBe(cacheBefore);
  });

  describe("with an anisotropic resolution (voxel model space, nm centers)", () => {
    const resolution: [number, number, number] = [16, 16, 45];

    it("orders by physical nm distance to the focus, not raw coordinate magnitude", () => {
      const index = new FragmentSpatialIndex(resolution);
      // focusModel is in voxels (100, 0, 0) -> focus in nm is (1600, 0, 0).
      // "physically-near" is 50nm from that focus; "origin-near" is 1550nm
      // from it despite having the smaller raw nm coordinate. Under the old
      // bug (nm centers compared directly against a voxel-space focus with
      // no conversion), "origin-near" would have sorted first.
      index.setFromManifest(
        ["physically-near:0", "origin-near:0"],
        [1650, 0, 0, 50, 0, 0],
        [5, 5],
      );
      const mvp = mat4.ortho(
        mat4.create(),
        -1000,
        1000,
        -1000,
        1000,
        -1000,
        1000,
      );
      const hint: FragmentSpatialHint = {
        clippingPlanes: getFrustrumPlanes(new Float32Array(24), mvp),
        focusModel: vec3.fromValues(100, 0, 0),
      };
      index.updateHint(hint);
      expect(index.score("physically-near:0")).toBeLessThan(
        index.score("origin-near:0"),
      );
    });

    it("classifies a piece by its MODEL-space position, not its raw nm coordinates", () => {
      const index = new FragmentSpatialIndex(resolution);
      // Raw nm coordinate (3000) is outside a +/-200 box, but the
      // MODEL-space position (3000 / 16 = 187.5) is inside it.
      index.setFromManifest(["big:0"], [3000, 0, 0], [5]);
      const mvp = mat4.ortho(mat4.create(), -200, 200, -200, 200, -200, 200);
      const hint: FragmentSpatialHint = {
        clippingPlanes: getFrustrumPlanes(new Float32Array(24), mvp),
        focusModel: vec3.fromValues(0, 0, 0),
      };
      index.updateHint(hint);
      // In-frustum score is the nm distance to the focus (0); out-of-frustum
      // would be OUT_OF_VIEW_OFFSET (~2^53) larger.
      expect(index.score("big:0")).toBe(3000);
    });
  });

  it("isOutOfView returns true for a known-bounds fragment fully outside the frustum", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["outside:0"], [10000, 0, 0], [1]);
    index.updateHint(makeHint());
    expect(index.isOutOfView("outside:0")).toBe(true);
  });

  it("isOutOfView returns false for an in-frustum fragment", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["near:0"], [10, 0, 0], [5]);
    index.updateHint(makeHint());
    expect(index.isOutOfView("near:0")).toBe(false);
  });

  it("isOutOfView returns false for an unknown-bounds fragment even at an out-of-frustum position", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["unknown:0"], [10000, 0, 0], [-1]);
    index.updateHint(makeHint());
    expect(index.isOutOfView("unknown:0")).toBe(false);
  });

  it("isOutOfView returns false for a fragment id never registered via setFromManifest", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["outside:0"], [10000, 0, 0], [1]);
    index.updateHint(makeHint());
    expect(index.isOutOfView("never-seen:0")).toBe(false);
  });

  it("isOutOfView returns false for every fragment when no hint has been set", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      ["near:0", "outside:0", "unknown:0"],
      [10, 0, 0, 10000, 0, 0, 0, 0, 0],
      [5, 1, -1],
    );
    expect(index.isOutOfView("near:0")).toBe(false);
    expect(index.isOutOfView("outside:0")).toBe(false);
    expect(index.isOutOfView("unknown:0")).toBe(false);
  });

  it("isOutOfView returns false for every fragment after updateHint(null)", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      ["near:0", "outside:0"],
      [10, 0, 0, 10000, 0, 0],
      [5, 1],
    );
    index.updateHint(makeHint());
    index.updateHint(null);
    expect(index.isOutOfView("near:0")).toBe(false);
    expect(index.isOutOfView("outside:0")).toBe(false);
  });

  it("isOutOfView reflects the latest hint when the view moves onto and off of a fragment", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      ["origin:0", "distant:0"],
      [10, 0, 0, 10000, 0, 0],
      [5, 1],
    );
    const distantMvp = mat4.ortho(
      mat4.create(),
      9000,
      11000,
      -1000,
      1000,
      -1000,
      1000,
    );
    const distantHint: FragmentSpatialHint = {
      clippingPlanes: getFrustrumPlanes(new Float32Array(24), distantMvp),
      focusModel: vec3.fromValues(10000, 0, 0),
    };
    index.updateHint(makeHint());
    expect(index.isOutOfView("distant:0")).toBe(true);
    expect(index.isOutOfView("origin:0")).toBe(false);
    index.updateHint(distantHint);
    expect(index.isOutOfView("distant:0")).toBe(false);
    expect(index.isOutOfView("origin:0")).toBe(true);
  });

  it("falls back to identity resolution ([1, 1, 1]) when given an invalid array", () => {
    const index = new FragmentSpatialIndex([16, 0, 45]);
    index.setFromManifest(["near:0", "far:0"], [10, 0, 0, 50, 0, 0], [5, 5]);
    index.updateHint(makeHint());
    expect(index.score("near:0")).toBe(10);
    expect(index.score("near:0")).toBeLessThan(index.score("far:0"));
  });

  it("isOutOfView returns true for a piece whose sphere lies 400 units beyond the +x frustum face", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["beyond:0"], [1500, 0, 0], [100]);
    index.updateHint(makeHint());
    expect(index.isOutOfView("beyond:0")).toBe(true);
  });

  it("isOutOfView returns false for a piece whose sphere straddles the +x frustum face", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["straddling:0"], [1050, 0, 0], [100]);
    index.updateHint(makeHint());
    expect(index.isOutOfView("straddling:0")).toBe(false);
  });

  it("updateHint returns false for a hint with NaN in clippingPlanes and keeps the previous classification", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["outside:0"], [10000, 0, 0], [1]);
    index.updateHint(makeHint());
    const badHint = makeHint();
    badHint.clippingPlanes[0] = NaN;
    expect(index.updateHint(badHint)).toBe(false);
    expect(index.isOutOfView("outside:0")).toBe(true);
  });

  it("updateHint returns false for a hint with NaN in focusModel and keeps the previous classification", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(["outside:0"], [10000, 0, 0], [1]);
    index.updateHint(makeHint());
    const badHint = makeHint();
    badHint.focusModel[1] = NaN;
    expect(index.updateHint(badHint)).toBe(false);
    expect(index.isOutOfView("outside:0")).toBe(true);
  });

  it("updateHint returns false for a first hint with non-finite planes and leaves every piece not out of view", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      ["near:0", "outside:0"],
      [10, 0, 0, 10000, 0, 0],
      [5, 1],
    );
    const badHint = makeHint();
    badHint.clippingPlanes[7] = Infinity;
    expect(index.updateHint(badHint)).toBe(false);
    expect(index.isOutOfView("near:0")).toBe(false);
    expect(index.isOutOfView("outside:0")).toBe(false);
  });
});
