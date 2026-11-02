import { describe, expect, it } from "vitest";
import type { Annotation, Line, Point } from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationSource,
  AnnotationType,
} from "#src/annotation/index.js";

const RANK = 3;

function point(id: string, position: number[]): Point {
  return {
    type: AnnotationType.POINT,
    id,
    point: Float32Array.from(position),
    properties: [],
  };
}

function line(id: string, pointA: number[], pointB: number[]): Line {
  return {
    type: AnnotationType.LINE,
    id,
    pointA: Float32Array.from(pointA),
    pointB: Float32Array.from(pointB),
    properties: [],
  };
}

function serializedByNg(source: AnnotationSource, annotations: Annotation[]) {
  const serializer = new AnnotationSerializer(
    source.annotationPropertySerializers,
  );
  for (const annotation of annotations) serializer.add(annotation);
  return serializer.serialize();
}

describe("AnnotationSource.serializeForRender", () => {
  it("matches AnnotationSerializer for every annotation without a filter", () => {
    const source = new AnnotationSource(RANK);
    source.add(point("p1", [1, 2, 3]));
    source.add(line("l1", [0, 0, 0], [4, 5, 6]));
    const rendered = source.serializeForRender(undefined);
    expect(rendered.data).toEqual(serializedByNg(source, [...source]).data);
    expect(rendered.typeToIds[AnnotationType.POINT].at(0)).toBe("p1");
    expect(rendered.typeToIdMaps[AnnotationType.LINE].get("l1")).toBe(0);
  });

  it("keeps only annotations the filter accepts", () => {
    const source = new AnnotationSource(RANK);
    source.add(point("p1", [1, 2, 3]));
    source.add(point("p2", [4, 5, 6]));
    const rendered = source.serializeForRender(
      (annotation) => annotation.id === "p2",
    );
    expect(rendered.typeToSize[AnnotationType.POINT]).toBe(1);
    expect(rendered.typeToIds[AnnotationType.POINT].at(0)).toBe("p2");
  });

  it("is listed in the annotation list by default", () => {
    expect(new AnnotationSource(RANK).listedInAnnotationList).toBe(true);
  });
});
