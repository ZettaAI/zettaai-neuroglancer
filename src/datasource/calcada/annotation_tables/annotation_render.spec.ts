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
import { AnnotationType } from "#src/annotation/index.js";
import {
  ANNOTATION_TABLE_COLORS,
  colorForTable,
  toLayerAnnotations,
} from "#src/datasource/calcada/annotation_tables/annotation_render.js";
import type {
  AnnotationTableInfo,
  SegmentAnnotation,
  SegmentAnnotations,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";

const TABLE: AnnotationTableInfo = {
  name: "syn",
  schemaName: "synapse",
  schemaVersion: 1,
  description: "",
  voxelResolution: [4, 4, 40],
  points: ["pre", "post"],
  properties: {},
};

const toLayer = (nm: [number, number, number]) =>
  Float32Array.of(nm[0] / 2, nm[1] / 2, nm[2] / 2);

const point = (
  name: string,
  position: [number, number, number],
  rootId: bigint,
) => ({ name, position, pieceId: 1n, rootId });

const row = (
  id: bigint,
  points: ReturnType<typeof point>[],
  value = 0.5,
): SegmentAnnotation => ({ id, value, payload: {}, points });

const response = (
  rootId: bigint,
  annotations: SegmentAnnotation[],
): SegmentAnnotations => ({
  rootId,
  tables: new Map([["syn", { annotations }]]),
});

const renderRows = (...responses: SegmentAnnotations[]) =>
  toLayerAnnotations(
    new Map(responses.map((r) => [r.rootId, r])),
    TABLE,
    toLayer,
  );

const render = (...responses: SegmentAnnotations[]) =>
  renderRows(...responses).flatMap(({ annotations }) => annotations);

describe("toLayerAnnotations", () => {
  it("draws a one-point row as a point scaled by the table resolution", () => {
    const [annotation] = render(
      response(10n, [row(7n, [point("p", [1, 2, 3], 10n)])]),
    );
    expect(annotation.type).toBe(AnnotationType.POINT);
    expect(annotation.id).toBe("syn:7");
    expect(Array.from((annotation as any).point)).toEqual([2, 4, 60]);
    expect(annotation.properties).toEqual([0.5]);
    expect(annotation.relatedSegments).toEqual([BigUint64Array.of(10n)]);
  });

  it("draws a two-point row as a line from role 0 to role 1", () => {
    const [annotation] = render(
      response(10n, [
        row(7n, [point("pre", [0, 0, 0], 10n), point("post", [2, 2, 1], 10n)]),
      ]),
    );
    expect(annotation.type).toBe(AnnotationType.LINE);
    expect(annotation.id).toBe("syn:7");
    expect(Array.from((annotation as any).pointA)).toEqual([0, 0, 0]);
    expect(Array.from((annotation as any).pointB)).toEqual([4, 4, 20]);
  });

  it("draws a three-point row as one point per role", () => {
    const annotations = render(
      response(10n, [
        row(7n, [
          point("a", [0, 0, 0], 10n),
          point("b", [1, 0, 0], 10n),
          point("c", [2, 0, 0], 10n),
        ]),
      ]),
    );
    expect(annotations.map((a) => a.id)).toEqual([
      "syn:7:0",
      "syn:7:1",
      "syn:7:2",
    ]);
    expect(annotations.every((a) => a.type === AnnotationType.POINT)).toBe(
      true,
    );
  });

  it("skips rows without points", () => {
    expect(render(response(10n, [row(7n, [])]))).toEqual([]);
  });

  it("draws a cross-segment row once and relates it to both visible roots", () => {
    const shared = row(7n, [
      point("pre", [0, 0, 0], 10n),
      point("post", [1, 1, 1], 20n),
    ]);
    const annotations = render(
      response(10n, [shared]),
      response(20n, [shared]),
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0].relatedSegments).toEqual([
      BigUint64Array.of(10n, 20n),
    ]);
  });

  it("pairs each drawn row with the annotations it became", () => {
    const shared = row(7n, [
      point("pre", [0, 0, 0], 10n),
      point("post", [1, 1, 1], 20n),
    ]);
    const rows = renderRows(
      response(10n, [shared, row(8n, [])]),
      response(20n, [shared]),
    );
    expect(rows.map(({ row: drawn }) => drawn.id)).toEqual([7n]);
    expect(rows[0].annotations.map(({ id }) => id)).toEqual(["syn:7"]);
  });

  it("ignores roots that are not visible and falls back to the fetched root", () => {
    const [partner] = render(
      response(10n, [
        row(7n, [point("pre", [0, 0, 0], 10n), point("post", [1, 1, 1], 99n)]),
      ]),
    );
    expect(partner.relatedSegments).toEqual([BigUint64Array.of(10n)]);
    const [unresolved] = render(
      response(10n, [row(8n, [point("p", [0, 0, 0], 0n)])]),
    );
    expect(unresolved.relatedSegments).toEqual([BigUint64Array.of(10n)]);
  });
});

describe("colorForTable", () => {
  it("offers eight colours and wraps around", () => {
    expect(ANNOTATION_TABLE_COLORS).toHaveLength(8);
    expect(colorForTable(8)).toBe(colorForTable(0));
    expect(colorForTable(3)).toBe(ANNOTATION_TABLE_COLORS[3]);
  });
});
