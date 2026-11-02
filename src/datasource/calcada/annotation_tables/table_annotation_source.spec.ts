/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest";
import type {
  Annotation,
  AnnotationId,
  AnnotationPropertySpec,
} from "#src/annotation/index.js";
import { AnnotationSerializer, AnnotationType } from "#src/annotation/index.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import { CalcadaTableAnnotationSource } from "#src/datasource/calcada/annotation_tables/table_annotation_source.js";
import {
  annotationOfInstance,
  buildTableRows,
  instanceId,
} from "#src/datasource/calcada/annotation_tables/table_rows.js";
import {
  fixturePoint,
  fixtureResponse,
  fixtureRow,
  fixtureTable,
  HALF_NANOMETRE_SCALE,
} from "#src/datasource/calcada/annotation_tables/table_rows_fixture.js";
import { WatchableValue } from "#src/trackable_value.js";

const LARGE_TABLE_SIZE = 100_000;
const TABLE = "syn";

const makeSource = ({
  isReadonly = () => false,
  onDelete = () => Promise.resolve(),
  onCreate = () => Promise.reject(new Error("not written")),
  properties = [],
}: {
  properties?: AnnotationPropertySpec[];
  isReadonly?: () => boolean;
  onDelete?: (annotation: Annotation) => Promise<void>;
  onCreate?: (annotation: Annotation) => Promise<AnnotationId>;
} = {}) =>
  new CalcadaTableAnnotationSource(
    new WatchableCoordinateSpaceTransform(
      makeIdentityTransform(
        makeCoordinateSpace({
          names: ["x", "y", "z"],
          units: ["m", "m", "m"],
          scales: Float64Array.of(1, 1, 1),
        }),
      ),
    ),
    new WatchableValue(properties),
    ["associated segments"],
    { isReadonly, onDelete, onCreate },
  );

const pointAnnotation = (id: string): Annotation => ({
  id,
  type: AnnotationType.POINT,
  point: Float32Array.of(0, 0, 0),
  relatedSegments: [BigUint64Array.of()],
  properties: [],
});

/** Rows of TABLE, one per id, each with `pointCount` points at [id, k, 1]. */
function tableRows(ids: number[], pointCount = 1) {
  return buildTableRows(
    [
      fixtureResponse(
        10n,
        ids.map((id) =>
          fixtureRow(
            BigInt(id),
            Array.from({ length: pointCount }, (_, k) =>
              fixturePoint([id, k, 1], 10n),
            ),
            id / 10,
          ),
        ),
      ),
    ],
    fixtureTable(TABLE, pointCount),
    HALF_NANOMETRE_SCALE,
  );
}

function serializedByNg(
  source: CalcadaTableAnnotationSource,
  annotations: Iterable<Annotation>,
) {
  const serializer = new AnnotationSerializer(
    source.annotationPropertySerializers,
  );
  for (const annotation of annotations) serializer.add(annotation);
  return serializer.serialize();
}

const VALUE_PROPERTY = {
  type: "float32" as const,
  identifier: "value",
  description: undefined,
  default: 0,
};

describe("CalcadaTableAnnotationSource", () => {
  it("lists rows then placed annotations by index without making the others", () => {
    const source = makeSource({
      onCreate: () => new Promise<AnnotationId>(() => {}),
    });
    const rows = tableRows([4, 7], 3);
    source.showRows(rows);
    source.setDescription("syn:7:1", "payload");
    const placed = source.add(pointAnnotation(""));
    const list = source.annotationList();
    expect(list.length).toBe(7);
    expect(list.at(4)).toEqual({
      ...annotationOfInstance(rows, 4),
      description: "payload",
    });
    expect(list.at(6).id).toBe(placed.id);
    expect(list.indexOf("syn:7:1")).toBe(4);
    expect(list.indexOf(placed.id)).toBe(6);
    expect(list.indexOf("syn:5")).toBeUndefined();
    placed.dispose();
  });

  it("showRows tells lists to reorder, once", () => {
    const source = makeSource();
    const reordered = vi.fn();
    source.childrenReordered.add(reordered);
    source.showRows(tableRows([1]));
    expect(reordered).toHaveBeenCalledTimes(1);
  });

  it("serializeForRender without a filter equals NG's own serializer over the same annotations", () => {
    const source = makeSource({ properties: [VALUE_PROPERTY] });
    const rows = tableRows([1, 2, 3], 2);
    source.showRows(rows);
    const rendered = source.serializeForRender(undefined);
    expect(rendered.data).toEqual(serializedByNg(source, source).data);
    expect(rendered.typeToSize[AnnotationType.LINE]).toBe(3);
    expect(rendered.typeToSize[AnnotationType.POINT]).toBe(0);
    expect(
      rendered.typeToIdMaps[AnnotationType.LINE].get(instanceId(rows, 2)),
    ).toBe(2);
    expect(rendered.typeToIds[AnnotationType.LINE].at(1)).toBe("syn:2");
    expect(rendered.typeToIds[AnnotationType.LINE].length).toBe(3);
  });

  it("serializes multi-point POINT rows as NG does", () => {
    const source = makeSource({ properties: [VALUE_PROPERTY] });
    source.showRows(tableRows([5, 9], 3));
    const rendered = source.serializeForRender(undefined);
    expect(rendered.data).toEqual(serializedByNg(source, source).data);
    expect(rendered.typeToSize[AnnotationType.POINT]).toBe(6);
    expect(rendered.typeToIdMaps[AnnotationType.POINT].get("syn:9:1")).toBe(4);
  });

  it("serializes a placed annotation after the rows", () => {
    const source = makeSource({
      properties: [VALUE_PROPERTY],
      onCreate: () => new Promise<AnnotationId>(() => {}),
    });
    source.showRows(tableRows([1, 2]));
    const placed = source.add({
      ...pointAnnotation(""),
      properties: [0],
    });
    const rendered = source.serializeForRender(undefined);
    expect(rendered.data).toEqual(serializedByNg(source, source).data);
    expect(rendered.typeToSize[AnnotationType.POINT]).toBe(3);
    expect(rendered.typeToIds[AnnotationType.POINT].at(2)).toBe(placed.id);
    expect(rendered.typeToIdMaps[AnnotationType.POINT].get(placed.id)).toBe(2);
    placed.dispose();
  });

  it("serializeForRender with a filter keeps only matching rows", () => {
    const source = makeSource({ properties: [VALUE_PROPERTY] });
    source.showRows(tableRows([1, 2, 3]));
    const rendered = source.serializeForRender(
      (annotation) => annotation.id === "syn:2",
    );
    expect(rendered.typeToSize[AnnotationType.POINT]).toBe(1);
    expect(rendered.typeToIds[AnnotationType.POINT].at(0)).toBe("syn:2");
  });

  it("makes a row's annotation on demand, through get and references", () => {
    const source = makeSource();
    const rows = tableRows([4, 7]);
    source.showRows(rows);
    expect(source.get("syn:7")).toEqual(annotationOfInstance(rows, 1));
    expect(source.get("syn:5")).toBeUndefined();
    const reference = source.getReference("syn:4");
    expect(reference.value).toEqual(annotationOfInstance(rows, 0));
    expect([...source].map(({ id }) => id)).toEqual(["syn:4", "syn:7"]);
    reference.dispose();
  });

  it("showRows dispatches changed once and refreshes live references", () => {
    const source = makeSource();
    source.showRows(tableRows([1, 2]));
    const kept = source.getReference("syn:1");
    const dropped = source.getReference("syn:2");
    const changed = vi.fn();
    const reordered = vi.fn();
    const keptChanged = vi.fn();
    source.changed.add(changed);
    source.childrenReordered.add(reordered);
    kept.changed.add(keptChanged);
    const replacement = tableRows([1, 3]);
    source.showRows(replacement);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(reordered).toHaveBeenCalledTimes(1);
    expect(keptChanged).toHaveBeenCalledTimes(1);
    expect(kept.value).toEqual(annotationOfInstance(replacement, 0));
    expect(dropped.value).toBeNull();
    kept.dispose();
    dropped.dispose();
  });

  it(`shows ${LARGE_TABLE_SIZE} rows without adding a child per row`, () => {
    const source = makeSource();
    const added = vi.fn();
    source.childAdded.add(added);
    source.showRows(
      tableRows(Array.from({ length: LARGE_TABLE_SIZE }, (_, i) => i + 1)),
    );
    expect(added).not.toHaveBeenCalled();
    expect(
      source.serializeForRender(undefined).typeToSize[AnnotationType.POINT],
    ).toBe(LARGE_TABLE_SIZE);
  });

  it("keeps the description of a described row across showRows", () => {
    const source = makeSource();
    source.showRows(tableRows([5, 6]));
    source.setDescription("syn:5", "payload");
    source.showRows(tableRows([5, 6]));
    expect(source.get("syn:5")?.description).toBe("payload");
    const reference = source.getReference("syn:5");
    expect(reference.value?.description).toBe("payload");
    reference.dispose();
  });

  it("drops the description of a row that left", () => {
    const source = makeSource();
    source.showRows(tableRows([5]));
    source.setDescription("syn:5", "payload");
    source.showRows(tableRows([]));
    source.showRows(tableRows([5]));
    expect(source.get("syn:5")?.description).toBeUndefined();
  });

  it("delete waits for onDelete and keeps the row when it rejects", async () => {
    let resolveDelete!: () => void;
    const onDelete = vi
      .fn<(annotation: Annotation) => Promise<void>>()
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
      )
      .mockRejectedValueOnce(new Error("forbidden"));
    const source = makeSource({ onDelete });
    source.showRows(tableRows([1, 2]));
    const accepted = source.get("syn:1")!;
    const refused = source.get("syn:2")!;

    const acceptedReference = source.getReference(accepted.id);
    const deleting = source.delete(acceptedReference);
    expect(onDelete).toHaveBeenCalledWith(accepted);
    expect(source.get(accepted.id)).toEqual(accepted);
    resolveDelete();
    await deleting;
    expect(source.get(accepted.id)).toBeUndefined();

    const refusedReference = source.getReference(refused.id);
    await expect(source.delete(refusedReference)).rejects.toThrow("forbidden");
    expect(source.get(refused.id)).toEqual(refused);
    expect(refusedReference.value).toEqual(refused);
    acceptedReference.dispose();
    refusedReference.dispose();
  });

  it("delete resolves and drops the row from the buffer and the next showRows", async () => {
    const source = makeSource();
    source.showRows(tableRows([1, 2]));
    const deleted = vi.fn();
    source.childDeleted.add(deleted);
    const reference = source.getReference("syn:1");
    await source.delete(reference);
    expect(deleted).toHaveBeenCalledExactlyOnceWith("syn:1");
    const rendered = source.serializeForRender(undefined);
    expect(rendered.typeToSize[AnnotationType.POINT]).toBe(1);
    expect(rendered.typeToIds[AnnotationType.POINT].at(0)).toBe("syn:2");
    source.showRows(tableRows([2]));
    expect(source.get("syn:1")).toBeUndefined();
    reference.dispose();
  });

  it("a refused delete whose promise is dropped leaks no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const source = makeSource({
      onDelete: () => Promise.reject(new Error("forbidden")),
    });
    source.showRows(tableRows([1]));
    const reference = source.getReference("syn:1");
    void source.delete(reference);
    await new Promise((resolve) => setTimeout(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(source.get("syn:1")).toBeDefined();
    reference.dispose();
  });

  it("delete outlives the caller's reference and nulls references taken meanwhile", async () => {
    let resolveDelete!: () => void;
    const source = makeSource({
      onDelete: () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    });
    source.showRows(tableRows([1]));
    const callerReference = source.getReference("syn:1");
    const deleting = source.delete(callerReference);
    callerReference.dispose();
    const laterReference = source.getReference("syn:1");
    const notified = vi.fn();
    laterReference.changed.add(notified);
    resolveDelete();
    await deleting;
    expect(laterReference.value).toBeNull();
    expect(notified).toHaveBeenCalled();
    expect(source.get("syn:1")).toBeUndefined();
    laterReference.dispose();
  });

  it("delete skips rows a showRows removed during the round-trip", async () => {
    let resolveDelete!: () => void;
    const source = makeSource({
      onDelete: () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    });
    source.showRows(tableRows([1]));
    const reference = source.getReference("syn:1");
    const deleting = source.delete(reference);
    reference.dispose();
    source.showRows(tableRows([2]));
    const deleted = vi.fn();
    source.childDeleted.add(deleted);
    resolveDelete();
    await expect(deleting).resolves.toBeUndefined();
    expect(deleted).not.toHaveBeenCalled();
    expect(source.get("syn:2")).toBeDefined();
  });

  it("delete calls onDelete once for repeated deletes of one row", async () => {
    let resolveDelete!: () => void;
    const onDelete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const source = makeSource({ onDelete });
    source.showRows(tableRows([1]));
    const reference = source.getReference("syn:1");
    const first = source.delete(reference);
    const second = source.delete(reference);
    resolveDelete();
    await Promise.all([first, second]);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(source.get("syn:1")).toBeUndefined();
    reference.dispose();
  });

  it("ignores NG's edits of a row but takes the session's description", () => {
    const source = makeSource();
    const rows = tableRows([1]);
    source.showRows(rows);
    const reference = source.getReference("syn:1");
    source.update(reference, {
      ...pointAnnotation("syn:1"),
      description: "typed in",
    });
    source.addProperty({
      type: "float32",
      identifier: "extra",
      description: undefined,
      default: 0,
    });
    expect([...source]).toEqual([annotationOfInstance(rows, 0)]);
    expect(source.properties.value).toEqual([]);
    const referenceChanged = vi.fn();
    reference.changed.add(referenceChanged);
    source.setDescription("syn:1", "tag: soma");
    expect(source.get("syn:1")?.description).toBe("tag: soma");
    expect(reference.value?.description).toBe("tag: soma");
    expect(referenceChanged).toHaveBeenCalledTimes(1);
    source.setDescription("syn:1", "tag: soma");
    expect(referenceChanged).toHaveBeenCalledTimes(1);
    reference.dispose();
  });

  it("a description reaches its reference without redrawing the table", () => {
    const source = makeSource();
    source.showRows(tableRows([1]));
    const changed = vi.fn();
    const childUpdated = vi.fn();
    source.changed.add(changed);
    source.childUpdated.add(childUpdated);
    source.setDescription("syn:1", "size: 1242");
    expect(source.get("syn:1")?.description).toBe("size: 1242");
    expect(changed).not.toHaveBeenCalled();
    expect(childUpdated).not.toHaveBeenCalled();
  });

  it("a placed point is written and stays drawn until its row is", async () => {
    let resolveCreate!: (rowId: AnnotationId) => void;
    const onCreate = vi.fn(
      () =>
        new Promise<AnnotationId>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const source = makeSource({ onCreate });
    source.showRows(tableRows([1]));
    const reference = source.add(pointAnnotation(""));
    const placedId = reference.id;
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(source.get(placedId));
    source.showRows(tableRows([1]));
    expect(source.get(placedId)).toBeDefined();
    expect(source.takeWritten()).toEqual(new Map());
    resolveCreate("syn:2");
    await Promise.resolve();
    expect(source.takeWritten()).toEqual(new Map([[placedId, "syn:2"]]));
    source.showRows(tableRows([1, 2]));
    expect(source.get(placedId)).toBeUndefined();
    expect(reference.value).toBeNull();
    reference.dispose();
  });

  it("a line is written once, on commit, with its last update", () => {
    const onCreate = vi.fn(() => new Promise<AnnotationId>(() => {}));
    const source = makeSource({ onCreate });
    const reference = source.add(pointAnnotation(""), false);
    const moved = {
      ...pointAnnotation(reference.id),
      point: Float32Array.of(1, 2, 3),
    };
    source.update(reference, moved);
    expect(onCreate).not.toHaveBeenCalled();
    source.commit(reference);
    source.commit(reference);
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(moved);
    reference.dispose();
  });

  it("a line deleted while being drawn goes without a server call", async () => {
    const onCreate = vi.fn(() => new Promise<AnnotationId>(() => {}));
    const onDelete = vi.fn(() => Promise.resolve());
    const source = makeSource({ onCreate, onDelete });
    const reference = source.add(pointAnnotation(""), false);
    await source.delete(reference);
    expect(source.get(reference.id)).toBeUndefined();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    reference.dispose();
  });

  it("a refused write takes the placed annotation away", async () => {
    const source = makeSource({
      onCreate: () => Promise.reject(new Error("forbidden")),
    });
    const reference = source.add(pointAnnotation(""));
    await new Promise((resolve) => setTimeout(resolve));
    expect(source.get(reference.id)).toBeUndefined();
    expect(source.takeWritten()).toEqual(new Map());
    reference.dispose();
  });

  it("nothing is placed into a readonly table", () => {
    const onCreate = vi.fn(() => Promise.resolve("syn:1"));
    const source = makeSource({ isReadonly: () => true, onCreate });
    source.add(pointAnnotation("placed"));
    expect([...source]).toEqual([]);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("discardPlaced lets the next showRows drop placed annotations", () => {
    const source = makeSource({
      onCreate: () => new Promise<AnnotationId>(() => {}),
    });
    const reference = source.add(pointAnnotation(""));
    source.discardPlaced();
    source.showRows(tableRows([]));
    expect(source.get(reference.id)).toBeUndefined();
    reference.dispose();
  });

  it("readonly follows isReadonly", () => {
    let readonly = true;
    const source = makeSource({ isReadonly: () => readonly });
    expect(source.readonly).toBe(true);
    readonly = false;
    expect(source.readonly).toBe(false);
  });
});
