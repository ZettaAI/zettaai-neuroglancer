import { describe, expect, it } from "vitest";
import {
  arrowNeedsReversal,
  boxFromCorners,
  referenceDirection,
  sectionSpan,
  sectionToggleTarget,
  selectCorrespondences,
} from "#src/datasource/calcada/realign/realign_selection.js";

const box = boxFromCorners([100, 200, 32.5], [164, 248, 33.5]);

describe("boxFromCorners", () => {
  it("takes the section of the lower corner", () => {
    expect(box).toEqual({ x0: 100, y0: 200, x1: 164, y1: 248, z: 32 });
  });

  it("normalises reversed corners", () => {
    expect(boxFromCorners([164.4, 248.9, 33.5], [100.2, 200.7, 32.5])).toEqual({
      x0: 100,
      y0: 200,
      x1: 165,
      y1: 249,
      z: 32,
    });
  });
});

describe("selectCorrespondences", () => {
  it("maps the z0 end to start and the z0-1 end to end, in crop [y, x] pixels", () => {
    const selection = selectCorrespondences(box, [
      { id: "a", pointA: [110.5, 210.5, 32.5], pointB: [112.5, 205.5, 31.5] },
    ]);
    expect(selection.lines).toEqual([
      { id: "a", start: [10, 10], end: [5, 12] },
    ]);
    expect(selection.rejected).toEqual([]);
  });

  it("accepts a line drawn from the reference section to the moving one", () => {
    const selection = selectCorrespondences(box, [
      { id: "b", pointA: [112.5, 205.5, 31.5], pointB: [110.5, 210.5, 32.5] },
    ]);
    expect(selection.lines[0]).toEqual({
      id: "b",
      start: [10, 10],
      end: [5, 12],
    });
  });

  it("rejects lines not spanning z0-1 and z0", () => {
    const selection = selectCorrespondences(box, [
      { id: "same", pointA: [110, 210, 32.5], pointB: [112, 205, 32.5] },
      { id: "up", pointA: [110, 210, 32.5], pointB: [112, 205, 33.5] },
    ]);
    expect(selection.lines).toEqual([]);
    expect(selection.rejected).toEqual([
      { id: "same", reason: "not-across-sections" },
      { id: "up", reason: "not-across-sections" },
    ]);
  });

  it("rejects lines with an end outside the box", () => {
    const selection = selectCorrespondences(box, [
      { id: "out", pointA: [99, 210, 32.5], pointB: [112, 205, 31.5] },
    ]);
    expect(selection.rejected).toEqual([{ id: "out", reason: "outside-box" }]);
  });
});

describe("sectionSpan", () => {
  it("spans exactly the section under a click", () => {
    expect(sectionSpan(3103.5)).toEqual([3103, 3104]);
  });

  it("keeps a section boundary that came back a hair short", () => {
    expect(sectionSpan(3103.9999999999)).toEqual([3104, 3105]);
  });
});

describe("boxFromCorners on a two-section box", () => {
  it("takes the upper of the two sections the box covers", () => {
    expect(boxFromCorners([100, 200, 3103], [164, 248, 3105]).z).toBe(3104);
  });

  it("takes the span's section even when its lower bound came back a hair short", () => {
    expect(
      boxFromCorners([100, 200, 3103.9999999999], [164, 248, 3105]).z,
    ).toBe(3104);
  });
});

describe("arrowNeedsReversal", () => {
  it("reverses an arrow drawn from the reference section to the moving one", () => {
    expect(arrowNeedsReversal([1, 1, 3103.5], [2, 2, 3104.5], 3104, 3103)).toBe(
      true,
    );
  });

  it("keeps an arrow already drawn from the moving section", () => {
    expect(arrowNeedsReversal([1, 1, 3104.5], [2, 2, 3103.5], 3104, 3103)).toBe(
      false,
    );
  });

  it("leaves an arrow on other sections alone", () => {
    expect(arrowNeedsReversal([1, 1, 3102.5], [2, 2, 3103.5], 3104, 3103)).toBe(
      false,
    );
  });

  it("follows a reference above", () => {
    expect(arrowNeedsReversal([1, 1, 3106.5], [2, 2, 3104.5], 3104, 3106)).toBe(
      true,
    );
  });
});

describe("a reference section other than the one below", () => {
  it("takes the lower section of a box reaching up to a reference above", () => {
    expect(boxFromCorners([100, 200, 3104], [164, 248, 3107], 2).z).toBe(3104);
  });

  it("takes the upper section of a box reaching down to a reference two below", () => {
    expect(boxFromCorners([100, 200, 3102], [164, 248, 3105], -2).z).toBe(3104);
  });

  it("accepts arrows from the moving section to the reference above", () => {
    const moving = boxFromCorners([100, 200, 32], [164, 248, 35], 2);
    const selection = selectCorrespondences(
      moving,
      [
        {
          id: "up",
          pointA: [110.5, 210.5, 32.5],
          pointB: [112.5, 205.5, 34.5],
        },
        {
          id: "below",
          pointA: [110.5, 210.5, 32.5],
          pointB: [112.5, 205.5, 31.5],
        },
      ],
      2,
    );
    expect(selection.referenceSection).toBe(34);
    expect(selection.lines.map(({ id }) => id)).toEqual(["up"]);
    expect(selection.rejected).toEqual([
      { id: "below", reason: "not-across-sections" },
    ]);
  });
});

describe("referenceDirection", () => {
  it("names where the reference lies from the moving section", () => {
    expect(referenceDirection(-2)).toBe("below");
    expect(referenceDirection(1)).toBe("above");
  });
});

describe("sectionToggleTarget", () => {
  it("goes to the reference from the moving section and back from anywhere else", () => {
    expect(sectionToggleTarget(3104, 3104, 3102)).toBe(3102);
    expect(sectionToggleTarget(3102, 3104, 3102)).toBe(3104);
    expect(sectionToggleTarget(3110, 3104, 3102)).toBe(3104);
  });
});
