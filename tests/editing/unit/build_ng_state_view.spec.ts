/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The view parameters a scenario can add for the 3D-preview e2e (TM-490):
 * layout, 3D camera, 3D slices and selected segments. Every one defaults to
 * what the existing scenarios already get.
 */

import { describe, expect, it } from "vitest";

import {
  buildNgState,
  type FixturesIndex,
  type Scenario,
} from "#tests/editing/harness/build_ng_state.js";

const INDEX: FixturesIndex = {
  bucket: "zetta-editing-test",
  fixtures: [
    {
      id: "img_u8_raw",
      kind: "image",
      dtype: "uint8",
      encoding: "raw",
      chunk: [64, 64, 16],
      offset: [0, 0, 0],
      size: [128, 128, 16],
      resolutions: [[16, 16, 40]],
      source: "precomputed://gs://zetta-editing-test/img_u8_raw",
    },
    {
      id: "seg_u32_raw_offset",
      kind: "segmentation",
      dtype: "uint32",
      encoding: "raw",
      chunk: [64, 64, 16],
      offset: [128, 128, 8],
      size: [128, 128, 16],
      resolutions: [[16, 16, 40]],
      source: "precomputed://gs://zetta-editing-test/seg_u32_raw_offset",
    },
  ],
};

const plain: Scenario = {
  name: "plain",
  layers: [
    { fixtureId: "img_u8_raw", role: "image", writable: false },
    { fixtureId: "seg_u32_raw_offset", role: "target", writable: true },
  ],
};

describe("buildNgState view parameters", () => {
  it("keeps the existing defaults when none is given", () => {
    const state = buildNgState(plain, INDEX) as any;
    expect(state.layout).toBe("xy");
    expect(state).not.toHaveProperty("projectionOrientation");
    expect(state).not.toHaveProperty("projectionScale");
    expect(state).not.toHaveProperty("showSlices");
    expect(state.layers[1].segments).toEqual([]);
  });

  it("emits the layout, 3D camera and slice visibility", () => {
    const state = buildNgState(
      {
        ...plain,
        layout: "xy-3d",
        projectionOrientation: [0, 0, 0, 1],
        projectionScale: 256,
        showSlices: false,
      },
      INDEX,
    ) as any;
    expect(state.layout).toBe("xy-3d");
    expect(state.projectionOrientation).toEqual([0, 0, 0, 1]);
    expect(state.projectionScale).toBe(256);
    expect(state.showSlices).toBe(false);
  });

  it("selects the given segments on a segmentation layer only", () => {
    const state = buildNgState(
      {
        ...plain,
        layers: [
          {
            fixtureId: "img_u8_raw",
            role: "image",
            writable: false,
            segments: ["5"],
          },
          {
            fixtureId: "seg_u32_raw_offset",
            role: "target",
            writable: true,
            segments: ["3", "4"],
          },
        ],
      },
      INDEX,
    ) as any;
    expect(state.layers[0]).not.toHaveProperty("segments");
    expect(state.layers[1].segments).toEqual(["3", "4"]);
  });
});
