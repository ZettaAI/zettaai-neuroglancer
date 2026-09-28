import { describe, expect, it } from "vitest";
import {
  SPHERE_TRIANGLE_VERTEX_COUNT,
  buildUnitSphereTriangles,
  stepTraceSphereRadiusNm,
  traceSphereSemiAxes,
} from "#src/datasource/calcada/trace_cursor/trace_sphere_geometry.js";
import {
  TRACE_SPHERE_RADIUS_MAX_NM,
  TRACE_SPHERE_RADIUS_MIN_NM,
} from "#src/datasource/calcada/trace_state.js";

const coordinateSpace = {
  valid: true,
  rank: 3,
  scales: Float64Array.of(16e-9, 16e-9, 45e-9),
  units: ["m", "m", "m"],
} as any;

describe("stepTraceSphereRadiusNm", () => {
  it("grows and shrinks multiplicatively and comes back to itself", () => {
    const grown = stepTraceSphereRadiusNm(1000, 1);
    expect(grown).toBeGreaterThan(1000);
    expect(stepTraceSphereRadiusNm(grown, -1)).toBeCloseTo(1000, 6);
  });

  it("clamps to the configured bounds", () => {
    expect(stepTraceSphereRadiusNm(TRACE_SPHERE_RADIUS_MIN_NM, -1)).toBe(
      TRACE_SPHERE_RADIUS_MIN_NM,
    );
    expect(stepTraceSphereRadiusNm(TRACE_SPHERE_RADIUS_MAX_NM, 1)).toBe(
      TRACE_SPHERE_RADIUS_MAX_NM,
    );
  });
});

describe("traceSphereSemiAxes", () => {
  it("turns a nm radius into per-axis global units", () => {
    // vec3 is a Float32Array, so the tolerance is float32's, not float64's.
    const axes = traceSphereSemiAxes(1600, coordinateSpace)!;
    expect(axes[0]).toBeCloseTo(100, 4);
    expect(axes[1]).toBeCloseTo(100, 4);
    // 45 nm per voxel along Z: the same physical distance spans fewer units.
    expect(axes[2]).toBeCloseTo(1600 / 45, 4);
  });

  it("returns undefined when a scale is unusable", () => {
    const broken = {
      ...coordinateSpace,
      scales: Float64Array.of(0, 16e-9, 45e-9),
    } as any;
    expect(traceSphereSemiAxes(1600, broken)).toBeUndefined();
  });
});

describe("buildUnitSphereTriangles", () => {
  it("emits whole triangles on the unit sphere", () => {
    const verts = buildUnitSphereTriangles();
    expect(verts.length).toBe(SPHERE_TRIANGLE_VERTEX_COUNT * 3);
    expect(SPHERE_TRIANGLE_VERTEX_COUNT % 3).toBe(0);
    for (let i = 0; i < verts.length; i += 3) {
      expect(Math.hypot(verts[i], verts[i + 1], verts[i + 2])).toBeCloseTo(
        1,
        5,
      );
    }
  });
});
