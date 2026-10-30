/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  Annotation,
  AnnotationPropertySpec,
  AnnotationId,
  AnnotationReference,
} from "#src/annotation/index.js";
import { LocalAnnotationSource } from "#src/annotation/index.js";
import type { WatchableCoordinateSpaceTransform } from "#src/coordinate_transform.js";
import type { WatchableValue } from "#src/trackable_value.js";

export interface TableAnnotationSourceOptions {
  isReadonly: () => boolean;
  onDelete: (annotation: Annotation) => Promise<void>;
}

/**
 * A local source that takes a whole table at once and deletes server-first.
 * The rows belong to the server, so NG's own edits (placing, moving, editing a
 * description, changing the property schema) are ignored; delete stays.
 */
export class CalcadaTableAnnotationSource extends LocalAnnotationSource {
  private readonly onDelete: TableAnnotationSourceOptions["onDelete"];
  private readonly deletesInFlight = new Map<AnnotationId, Promise<void>>();

  constructor(
    watchableTransform: WatchableCoordinateSpaceTransform,
    properties: WatchableValue<AnnotationPropertySpec[]>,
    relationships: string[],
    { isReadonly, onDelete }: TableAnnotationSourceOptions,
  ) {
    super(watchableTransform, properties, relationships);
    this.onDelete = onDelete;
    // The base class declares `readonly` as an own field, which would shadow a getter.
    Object.defineProperty(this, "readonly", { get: isReadonly });
  }

  replaceAll(annotations: readonly Annotation[]) {
    this.ensureUpdated();
    this.annotationMap = new Map(
      annotations.map((annotation) => [annotation.id, annotation]),
    );
    this.pending.clear();
    for (const reference of this.references.values()) {
      reference.value = this.annotationMap.get(reference.id) ?? null;
      reference.changed.dispatch();
    }
    this.changed.dispatch();
    this.childrenReordered.dispatch();
  }

  setDescription(id: AnnotationId, description: string) {
    const annotation = this.get(id);
    if (annotation === undefined || annotation.description === description) {
      return;
    }
    const reference = this.getReference(id);
    try {
      super.update(reference, { ...annotation, description });
    } finally {
      reference.dispose();
    }
  }

  add(annotation: Annotation): AnnotationReference {
    return this.getReference(annotation.id);
  }

  update(_reference: AnnotationReference, _annotation: Annotation) {}

  addProperty(_property: AnnotationPropertySpec) {}

  removeProperty(_identifier: string) {}

  updateProperty(
    _oldProperty: AnnotationPropertySpec,
    _newPropertyValues: Partial<AnnotationPropertySpec>,
  ) {}

  removeAllProperties() {}

  delete(reference: AnnotationReference): Promise<void> {
    const { id } = reference;
    const inFlight = this.deletesInFlight.get(id);
    if (inFlight !== undefined) return inFlight;
    const annotation = reference.value;
    if (annotation == null) return Promise.resolve();
    const deleting = this.deleteAfterServer(this.getReference(id), annotation);
    // NG's delete buttons drop this promise; onDelete's owner reports the failure.
    deleting.catch(() => {});
    this.deletesInFlight.set(id, deleting);
    return deleting;
  }

  private async deleteAfterServer(
    reference: AnnotationReference,
    annotation: Annotation,
  ) {
    try {
      await this.onDelete(annotation);
      if (this.annotationMap.has(reference.id)) super.delete(reference);
    } finally {
      this.deletesInFlight.delete(reference.id);
      reference.dispose();
    }
  }
}
