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

import { applyMorphologyPipeline } from "#src/editing/tool_runtimes/mask_compute.js";
import { SCIPY_MORPHOLOGY_CASES } from "#src/editing/tool_runtimes/mask_compute_scipy_parity.fixture.js";

// The brush's binary closing and min component size run only in TS now (the
// pyodide/scipy worker is gone). This pins the TS kernel to scipy's output, the
// reference the old pyodide brush and the portal voxel editor both follow.
describe("brush mask morphology matches scipy", () => {
  it.each(SCIPY_MORPHOLOGY_CASES.map((c, index) => ({ ...c, index })))(
    "case $index: $width×$height closing=$binaryClosing minSize=$minComponentSize filterFirst=$filterComponentsFirst",
    (testCase) => {
      const data = Uint8Array.from(testCase.mask, (bit) => Number(bit));
      const out = applyMorphologyPipeline({
        mask: { data, shape: [testCase.width, testCase.height, 1] },
        binaryClosing: testCase.binaryClosing,
        minComponentSize: testCase.minComponentSize,
        filterComponentsFirst: testCase.filterComponentsFirst,
      });
      expect(Array.from(out.data).join("")).toBe(testCase.expected);
    },
  );
});
