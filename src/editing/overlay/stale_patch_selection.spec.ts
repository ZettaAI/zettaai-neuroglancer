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

import { chunksSafeToRefetch } from "#src/editing/overlay/stale_patch_selection.js";

describe("chunksSafeToRefetch", () => {
  it("refetches a chunk this session never painted", () => {
    expect(chunksSafeToRefetch(["0,0,0", "1,0,0"], new Set(["1,0,0"]))).toEqual(
      ["0,0,0"],
    );
  });

  /**
   * The rule that keeps this safe: a patch means this session put something
   * there, and only this session knows whether storage has it yet. Refetching
   * under a patch is what hid a colleague's work behind stale values and what
   * made saved-but-uncommitted paint vanish, so a patched chunk is never
   * touched — its exit-time invalidation still reconciles it.
   */
  it("leaves every patched chunk alone", () => {
    expect(chunksSafeToRefetch(["7,7,7"], new Set(["7,7,7"]))).toEqual([]);
  });

  it("refetches everything when nothing is painted", () => {
    expect(chunksSafeToRefetch(["0,0,0", "1,0,0"], new Set())).toEqual([
      "0,0,0",
      "1,0,0",
    ]);
  });

  it("has nothing to do when nothing is resident", () => {
    expect(chunksSafeToRefetch([], new Set(["0,0,0"]))).toEqual([]);
  });
});
