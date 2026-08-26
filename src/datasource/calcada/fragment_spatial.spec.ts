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

function fragments(ids: string[]) {
  return ids.map((id) => id.replace(/:0$/, ""));
}

describe("FragmentSpatialIndex", () => {
  it("orders known in-frustum pieces by distance to the focus", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      fragments(["near:0", "far:0"]),
      [10, 0, 0, 50, 0, 0],
      [5, 5],
    );
    index.updateHint(makeHint());
    expect(index.score("near:0")).toBeLessThan(index.score("far:0"));
    expect(index.compare("near:0", "far:0")).toBeLessThan(0);
  });

  it("scores an out-of-frustum piece after an unknown-bounds piece", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      fragments(["unknown:0", "outside:0"]),
      [0, 0, 0, 10000, 0, 0],
      [-1, 1],
    );
    index.updateHint(makeHint());
    expect(index.score("unknown:0")).toBeLessThan(index.score("outside:0"));
  });

  it("scores unknown-bounds pieces after every known in-frustum piece", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(
      fragments(["near:0", "far:0", "unknown:0"]),
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
      fragments(["near:0", "far:0", "unknown:0", "outside:0"]),
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
      fragments(["near:0", "far:0", "unknown:0", "outside:0"]),
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
    index.setFromManifest(fragments(["near:0"]), [10, 0, 0], [5]);
    index.setFromManifest(fragments(["far:0"]), [50, 0, 0], [5]);
    index.updateHint(makeHint());
    expect(index.score("near:0")).toBeLessThan(index.score("far:0"));
  });

  it("ignores frag_centers/frag_radii on length mismatch", () => {
    const index = new FragmentSpatialIndex();
    index.setFromManifest(fragments(["near:0", "far:0"]), [10, 0, 0], [5, 5]);
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
    index.setFromManifest(fragments(["unknown:0"]), [0, 0, 0], [-1]);
    index.updateHint(makeHint());
    expect(index.compare("never-seen:0", "unknown:0")).toBe(0);
    expect(index.priorityBias("never-seen:0")).toBe(0);
    expect(index.priorityBias("unknown:0")).toBe(-0.75);
  });
});
