/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";
import { PageWindows } from "#src/datasource/calcada/annotation_tables/annotation_page_windows.js";

describe("PageWindows", () => {
  it("starts every root on page one", () => {
    const windows = new PageWindows();
    expect(windows.page).toBe(1);
    expect(windows.hasPrevious).toBe(false);
    expect(windows.cursor("a")).toBeUndefined();
  });

  it("advances only the roots given and shows the deepest as the page", () => {
    const windows = new PageWindows();
    windows.advance(
      new Map([
        ["a", "10"],
        ["b", "20"],
      ]),
    );
    windows.advance(new Map([["a", "11"]]));
    expect(windows.page).toBe(3);
    expect(windows.cursor("a")).toBe("11");
    expect(windows.cursor("b")).toBe("20");
    expect(windows.cursor("new")).toBeUndefined();
  });

  it("steps back to exactly the earlier window", () => {
    const windows = new PageWindows();
    windows.advance(new Map([["a", "10"]]));
    windows.advance(
      new Map([
        ["a", "11"],
        ["late", "30"],
      ]),
    );
    expect(windows.back()).toEqual(["a", "late"]);
    expect(windows.cursor("a")).toBe("10");
    expect(windows.cursor("late")).toBeUndefined();
    expect(windows.page).toBe(2);
    expect(windows.back()).toEqual(["a"]);
    expect(windows.page).toBe(1);
    expect(windows.hasPrevious).toBe(false);
    expect(windows.back()).toEqual([]);
  });

  it("ignores an advance with no root to move", () => {
    const windows = new PageWindows();
    windows.advance(new Map());
    expect(windows.hasPrevious).toBe(false);
  });

  it("forgets a root and the steps that only it took", () => {
    const windows = new PageWindows();
    windows.advance(
      new Map([
        ["a", "10"],
        ["b", "20"],
      ]),
    );
    windows.advance(new Map([["b", "21"]]));
    windows.forget("b");
    expect(windows.page).toBe(2);
    expect(windows.back()).toEqual(["a"]);
    expect(windows.hasPrevious).toBe(false);
  });
});
