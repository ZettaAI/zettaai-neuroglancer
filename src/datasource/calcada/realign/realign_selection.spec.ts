import { describe, expect, it } from "vitest";
import {
  arrowNeedsReversal,
  boxFromCorners,
  sectionSpan,
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

describe("boxFromCorners on a section span", () => {
  it("takes the span's section even when its lower bound came back a hair short", () => {
    expect(
      boxFromCorners([100, 200, 3103.9999999999], [164, 248, 3105]).z,
    ).toBe(3104);
  });
});

describe("arrowNeedsReversal", () => {
  it("reverses an arrow drawn from the section below up to the box's section", () => {
    expect(arrowNeedsReversal([1, 1, 3103.5], [2, 2, 3104.5], 3104)).toBe(true);
  });

  it("keeps an arrow already drawn from the box's section down", () => {
    expect(arrowNeedsReversal([1, 1, 3104.5], [2, 2, 3103.5], 3104)).toBe(
      false,
    );
  });

  it("leaves an arrow on other sections alone", () => {
    expect(arrowNeedsReversal([1, 1, 3102.5], [2, 2, 3103.5], 3104)).toBe(
      false,
    );
  });
});
