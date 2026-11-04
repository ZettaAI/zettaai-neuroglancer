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
  ANNOTATION_TABLE_COLORS,
  annotationRowId,
  colorForTable,
  rowAnnotationId,
} from "#src/datasource/calcada/annotation_tables/annotation_render.js";

describe("annotationRowId", () => {
  it("gives back the row id of a row's annotation and of a point of it", () => {
    expect(annotationRowId("syn", rowAnnotationId("syn", 7n))).toBe(7n);
    expect(annotationRowId("syn", "syn:8:2")).toBe(8n);
  });
});

describe("colorForTable", () => {
  it("offers eight colours and wraps around", () => {
    expect(ANNOTATION_TABLE_COLORS).toHaveLength(8);
    expect(colorForTable(8)).toBe(colorForTable(0));
    expect(colorForTable(3)).toBe(ANNOTATION_TABLE_COLORS[3]);
  });
});
