import { describe, expect, it } from "vitest";
import { meshModelResolution } from "#src/datasource/calcada/mesh_model_resolution.js";
import { mat4 } from "#src/util/geom.js";

describe("meshModelResolution", () => {
  it("is the transform's diagonal (nm per mesh-model unit)", () => {
    const transform = mat4.fromScaling(mat4.create(), [32, 32, 45]);
    expect(meshModelResolution(transform)).toEqual([32, 32, 45]);
  });

  it("handles a non-uniform diagonal", () => {
    const transform = mat4.fromScaling(mat4.create(), [64, 16, 90]);
    expect(meshModelResolution(transform)).toEqual([64, 16, 90]);
  });

  it("is [1,1,1] for an identity transform (mesh coordinates already nm)", () => {
    const transform = mat4.create();
    expect(meshModelResolution(transform)).toEqual([1, 1, 1]);
  });
});
