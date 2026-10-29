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
import type { Annotation } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import { CalcadaTableAnnotationSource } from "#src/datasource/calcada/annotation_tables/table_annotation_source.js";
import { WatchableValue } from "#src/trackable_value.js";

const LARGE_TABLE_SIZE = 100_000;

const makeSource = ({
  isReadonly = () => false,
  onDelete = () => Promise.resolve(),
}: {
  isReadonly?: () => boolean;
  onDelete?: (annotation: Annotation) => Promise<void>;
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
    new WatchableValue([]),
    ["associated segments"],
    { isReadonly, onDelete },
  );

const pointAnnotation = (id: string): Annotation => ({
  id,
  type: AnnotationType.POINT,
  point: Float32Array.of(0, 0, 0),
  relatedSegments: [BigUint64Array.of()],
  properties: [],
});

describe("CalcadaTableAnnotationSource", () => {
  it("replaceAll dispatches one changed and one childrenReordered for 100 000 annotations", () => {
    const source = makeSource();
    source.replaceAll([pointAnnotation("old")]);
    const changed = vi.fn();
    const reordered = vi.fn();
    const added = vi.fn();
    source.changed.add(changed);
    source.childrenReordered.add(reordered);
    source.childAdded.add(added);
    source.replaceAll(
      Array.from({ length: LARGE_TABLE_SIZE }, (_, i) =>
        pointAnnotation(`syn:${i}`),
      ),
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(reordered).toHaveBeenCalledTimes(1);
    expect(added).not.toHaveBeenCalled();
    expect([...source].length).toBe(LARGE_TABLE_SIZE);
    expect(source.get("old")).toBeUndefined();
  });

  it("replaceAll points live references at the new annotations", () => {
    const source = makeSource();
    source.replaceAll([pointAnnotation("a"), pointAnnotation("b")]);
    const kept = source.getReference("a");
    const dropped = source.getReference("b");
    const replacement = pointAnnotation("a");
    source.replaceAll([replacement]);
    expect(kept.value).toBe(replacement);
    expect(dropped.value).toBeNull();
    kept.dispose();
    dropped.dispose();
  });

  it("delete waits for onDelete and keeps the annotation when it rejects", async () => {
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
    const accepted = pointAnnotation("syn:1");
    const refused = pointAnnotation("syn:2");
    source.replaceAll([accepted, refused]);

    const acceptedReference = source.getReference(accepted.id);
    const deleting = source.delete(acceptedReference);
    expect(onDelete).toHaveBeenCalledWith(accepted);
    expect(source.get(accepted.id)).toBe(accepted);
    resolveDelete();
    await deleting;
    expect(source.get(accepted.id)).toBeUndefined();

    const refusedReference = source.getReference(refused.id);
    await expect(source.delete(refusedReference)).rejects.toThrow("forbidden");
    expect(source.get(refused.id)).toBe(refused);
    expect(refusedReference.value).toBe(refused);
    acceptedReference.dispose();
    refusedReference.dispose();
  });

  it("a refused delete whose promise is dropped leaks no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const source = makeSource({
      onDelete: () => Promise.reject(new Error("forbidden")),
    });
    const refused = pointAnnotation("syn:1");
    source.replaceAll([refused]);
    const reference = source.getReference(refused.id);
    void source.delete(reference);
    await new Promise((resolve) => setTimeout(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(source.get(refused.id)).toBe(refused);
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
    source.replaceAll([pointAnnotation("syn:1")]);
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

  it("delete skips rows a replaceAll removed during the round-trip", async () => {
    let resolveDelete!: () => void;
    const source = makeSource({
      onDelete: () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    });
    source.replaceAll([pointAnnotation("syn:1")]);
    const reference = source.getReference("syn:1");
    const deleting = source.delete(reference);
    reference.dispose();
    source.replaceAll([pointAnnotation("syn:2")]);
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
    source.replaceAll([pointAnnotation("syn:1")]);
    const reference = source.getReference("syn:1");
    const first = source.delete(reference);
    const second = source.delete(reference);
    resolveDelete();
    await Promise.all([first, second]);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(source.get("syn:1")).toBeUndefined();
    reference.dispose();
  });

  it("ignores NG's own edits but takes the session's description", () => {
    const source = makeSource();
    const annotation = pointAnnotation("syn:1");
    source.replaceAll([annotation]);
    const reference = source.getReference(annotation.id);
    source.update(reference, {
      ...pointAnnotation(annotation.id),
      description: "typed in",
    });
    source.add(pointAnnotation("placed"));
    source.addProperty({
      type: "float32",
      identifier: "extra",
      description: undefined,
      default: 0,
    });
    expect([...source]).toEqual([annotation]);
    expect(source.properties.value).toEqual([]);
    const updated = vi.fn();
    source.childUpdated.add(updated);
    source.setDescription(annotation.id, "tag: soma");
    expect(source.get(annotation.id)?.description).toBe("tag: soma");
    expect(reference.value?.description).toBe("tag: soma");
    expect(updated).toHaveBeenCalledTimes(1);
    source.setDescription(annotation.id, "tag: soma");
    expect(updated).toHaveBeenCalledTimes(1);
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
