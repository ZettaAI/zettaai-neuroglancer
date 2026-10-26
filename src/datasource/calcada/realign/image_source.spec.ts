import { describe, expect, it } from "vitest";
import {
  calcadaImageSource,
  isCalcadaImageSource,
} from "#src/datasource/calcada/realign/image_source.js";

const GRAPH_URL = "https://calcada.example/segmentation/api/v1/table/fafb";
const SOURCE =
  "middleauth+https://calcada.example/segmentation/table/fafb/image/0/|neuroglancer-precomputed:";

describe("calcada image source", () => {
  it("recognises calcada's image source and nothing else", () => {
    expect(isCalcadaImageSource(SOURCE, GRAPH_URL)).toBe(true);
    expect(
      isCalcadaImageSource(
        "gs://bucket/img/|neuroglancer-precomputed:",
        GRAPH_URL,
      ),
    ).toBe(false);
    expect(
      isCalcadaImageSource(
        "calcada://middleauth+https://calcada.example/segmentation/table/fafb",
        GRAPH_URL,
      ),
    ).toBe(false);
  });

  it("leaves another graph's image source alone", () => {
    expect(
      isCalcadaImageSource(
        "middleauth+https://calcada.example/segmentation/table/fafb_v2/image/0/|neuroglancer-precomputed:",
        GRAPH_URL,
      ),
    ).toBe(false);
    expect(
      isCalcadaImageSource(
        "middleauth+https://calcada-dev.example/segmentation/table/fafb/image/0/|neuroglancer-precomputed:",
        GRAPH_URL,
      ),
    ).toBe(false);
  });

  it("points the source at a branch", () => {
    expect(calcadaImageSource(SOURCE, 7, 0)).toBe(
      "middleauth+https://calcada.example/segmentation/table/fafb/image/7/|neuroglancer-precomputed:",
    );
  });

  it("carries a revision after the branch id and replaces an earlier one", () => {
    const revised = calcadaImageSource(SOURCE, 7, 2);
    expect(revised).toBe(
      "middleauth+https://calcada.example/segmentation/table/fafb/image/7.2/|neuroglancer-precomputed:",
    );
    expect(calcadaImageSource(revised, 3, 0)).toBe(
      "middleauth+https://calcada.example/segmentation/table/fafb/image/3/|neuroglancer-precomputed:",
    );
  });

  it("takes a branch segment written without a trailing slash", () => {
    const bare =
      "middleauth+https://calcada.example/segmentation/table/fafb/image/0|neuroglancer-precomputed:";
    expect(isCalcadaImageSource(bare, GRAPH_URL)).toBe(true);
    expect(calcadaImageSource(bare, 7, 1)).toBe(
      "middleauth+https://calcada.example/segmentation/table/fafb/image/7.1|neuroglancer-precomputed:",
    );
  });

  it("takes the versioned api form of the table path", () => {
    const versioned =
      "middleauth+https://calcada.example/segmentation/api/v1/table/fafb/image/0/|neuroglancer-precomputed:";
    expect(isCalcadaImageSource(versioned, GRAPH_URL)).toBe(true);
    expect(calcadaImageSource(versioned, 7, 1)).toBe(
      "middleauth+https://calcada.example/segmentation/api/v1/table/fafb/image/7.1/|neuroglancer-precomputed:",
    );
  });
});
