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

import {
  clampBinaryClosing,
  MAX_BINARY_CLOSING,
} from "#src/editing/tool_runtimes/paint_types.js";

describe("clampBinaryClosing", () => {
  it("caps at the portal voxel editor's maximum", () => {
    expect(MAX_BINARY_CLOSING).toBe(32);
    expect(clampBinaryClosing(32)).toBe(32);
    expect(clampBinaryClosing(33)).toBe(32);
    expect(clampBinaryClosing(50)).toBe(32);
  });

  it("keeps in-range counts, floors fractions and rejects negatives", () => {
    expect(clampBinaryClosing(0)).toBe(0);
    expect(clampBinaryClosing(4)).toBe(4);
    expect(clampBinaryClosing(4.9)).toBe(4);
    expect(clampBinaryClosing(-3)).toBe(0);
  });
});
