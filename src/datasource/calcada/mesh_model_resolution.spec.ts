import { describe, expect, it } from "vitest";
import { meshModelResolution } from "#src/datasource/calcada/mesh_model_resolution.js";
import { mat4 } from "#src/util/geom.js";

describe("meshModelResolution", () => {
  it("scales the graph resolution by the transform's diagonal", () => {
    const transform = mat4.fromScaling(mat4.create(), [2, 2, 1]);
    expect(meshModelResolution([16, 16, 45], transform)).toEqual([32, 32, 45]);
  });

  it("handles a non-uniform diagonal", () => {
    const transform = mat4.fromScaling(mat4.create(), [4, 1, 2]);
    expect(meshModelResolution([16, 16, 45], transform)).toEqual([64, 16, 90]);
  });

  it("passes through undefined when the graph resolution is unknown", () => {
    const transform = mat4.fromScaling(mat4.create(), [2, 2, 1]);
    expect(meshModelResolution(undefined, transform)).toBeUndefined();
  });

  it("is the identity when the transform is the identity matrix", () => {
    const transform = mat4.create();
    expect(meshModelResolution([16, 16, 45], transform)).toEqual([16, 16, 45]);
  });
});
