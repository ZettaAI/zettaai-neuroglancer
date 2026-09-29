import { describe, expect, it } from "vitest";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import {
  nanometresToGlobal,
  parsePieceSpheres,
} from "#src/datasource/calcada/piece_centers.js";

describe("parsePieceSpheres", () => {
  it("keys each sphere by the fragment's piece id", () => {
    const spheres = parsePieceSpheres({
      fragments: ["11:0", "22:0"],
      frag_centers: [1, 2, 3, 4, 5, 6],
      frag_radii: [10, 20],
    });
    expect(spheres.get(11n)).toEqual({ center: [1, 2, 3], radiusNm: 10 });
    expect(spheres.get(22n)).toEqual({ center: [4, 5, 6], radiusNm: 20 });
  });

  it("gives nothing when the lengths disagree or spheres are missing", () => {
    expect(
      parsePieceSpheres({
        fragments: ["11:0"],
        frag_centers: [1, 2],
        frag_radii: [10],
      }).size,
    ).toBe(0);
    expect(parsePieceSpheres({ fragments: ["11:0"] }).size).toBe(0);
    expect(parsePieceSpheres(undefined).size).toBe(0);
  });
});

describe("nanometresToGlobal", () => {
  it("divides by each axis's nanometres per unit", () => {
    const space = makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.of(16e-9, 16e-9, 45e-9),
    });
    expect(Array.from(nanometresToGlobal([160, 320, 450], space)!)).toEqual([
      10, 20, 10,
    ]);
  });
});
