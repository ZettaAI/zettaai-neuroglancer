import { describe, expect, it } from "vitest";
import type { Line } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import {
  isReverseArrowKey,
  isSectionToggleKey,
  REALIGN_ARROW_SHADER,
  reversedLine,
  withRejectedFlag,
} from "#src/datasource/calcada/realign/realign_arrows.js";

const line: Line = {
  id: "a",
  type: AnnotationType.LINE,
  pointA: Float32Array.from([1, 2, 3]),
  pointB: Float32Array.from([4, 5, 6]),
  properties: [0],
  description: "",
  relatedSegments: [],
};

describe("reversedLine", () => {
  it("swaps tail and head and keeps the rest", () => {
    const reversed = reversedLine(line);
    expect(Array.from(reversed.pointA)).toEqual([4, 5, 6]);
    expect(Array.from(reversed.pointB)).toEqual([1, 2, 3]);
    expect(reversed.id).toBe("a");
  });
});

describe("withRejectedFlag", () => {
  it("sets the flag only when it changes", () => {
    expect(withRejectedFlag(line, false)).toBeUndefined();
    expect(withRejectedFlag(line, true)?.properties).toEqual([1]);
  });
});

describe("isReverseArrowKey", () => {
  it("is Shift+R only, never plain R (NG's rotate)", () => {
    expect(
      isReverseArrowKey(
        new KeyboardEvent("keydown", { code: "KeyR", shiftKey: true }),
      ),
    ).toBe(true);
    expect(
      isReverseArrowKey(new KeyboardEvent("keydown", { code: "KeyR" })),
    ).toBe(false);
    expect(
      isReverseArrowKey(
        new KeyboardEvent("keydown", {
          code: "KeyR",
          shiftKey: true,
          ctrlKey: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("REALIGN_ARROW_SHADER", () => {
  // A user shader that never sets a box's border colour draws the box
  // transparent, so the realign box would be invisible.
  it("colours the box border", () => {
    expect(REALIGN_ARROW_SHADER).toContain("setBoundingBoxBorderColor(");
  });
});

describe("isSectionToggleKey", () => {
  it("is a bare Q", () => {
    expect(
      isSectionToggleKey(new KeyboardEvent("keydown", { code: "KeyQ" })),
    ).toBe(true);
    expect(
      isSectionToggleKey(
        new KeyboardEvent("keydown", { code: "KeyQ", ctrlKey: true }),
      ),
    ).toBe(false);
    expect(
      isSectionToggleKey(
        new KeyboardEvent("keydown", { code: "KeyQ", shiftKey: true }),
      ),
    ).toBe(false);
  });
});
