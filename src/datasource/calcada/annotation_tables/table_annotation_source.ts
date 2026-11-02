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
  /** Writes a placed annotation as a row; resolves to the id the row is drawn under. */
  onCreate: (annotation: Annotation) => Promise<AnnotationId>;
}

/**
 * A local source that takes a whole table at once and writes server-first.
 * The rows belong to the server, so NG's edits of them (moving, editing a
 * description, changing the property schema) are ignored; placing a new
 * annotation and deleting one stay.
 */
export class CalcadaTableAnnotationSource extends LocalAnnotationSource {
  private readonly onDelete: TableAnnotationSourceOptions["onDelete"];
  private readonly onCreate: TableAnnotationSourceOptions["onCreate"];
  private readonly deletesInFlight = new Map<AnnotationId, Promise<void>>();
  // Placed here and not yet drawn from the server, so carried across
  // replaceAll; once written, the id its row is drawn under.
  private readonly placed = new Map<AnnotationId, AnnotationId | undefined>();

  constructor(
    watchableTransform: WatchableCoordinateSpaceTransform,
    properties: WatchableValue<AnnotationPropertySpec[]>,
    relationships: string[],
    { isReadonly, onDelete, onCreate }: TableAnnotationSourceOptions,
  ) {
    super(watchableTransform, properties, relationships);
    this.onDelete = onDelete;
    this.onCreate = onCreate;
    // The base class declares `readonly` as an own field, which would shadow a getter.
    Object.defineProperty(this, "readonly", { get: isReadonly });
  }

  replaceAll(annotations: readonly Annotation[]) {
    this.ensureUpdated();
    const placed = [...this.placed.keys()].flatMap(
      (id) => this.annotationMap.get(id) ?? [],
    );
    this.annotationMap = new Map(
      [...annotations, ...placed].map((annotation) => [
        annotation.id,
        annotation,
      ]),
    );
    for (const reference of this.references.values()) {
      reference.value = this.annotationMap.get(reference.id) ?? null;
      reference.changed.dispatch();
    }
    this.changed.dispatch();
    this.childrenReordered.dispatch();
  }

  /**
   * Tells only the annotation's reference, which the Selection panel watches:
   * a description is not drawn, so the table's buffer and list stay as they are.
   */
  setDescription(id: AnnotationId, description: string) {
    const annotation = this.get(id);
    if (annotation === undefined || annotation.description === description) {
      return;
    }
    const described = { ...annotation, description };
    this.annotationMap.set(id, described);
    const reference = this.references.get(id);
    if (reference === undefined) return;
    reference.value = described;
    reference.changed.dispatch();
  }

  /**
   * Placed annotations whose rows are written, each with the id its row is
   * drawn under. They are no longer carried: the next replaceAll drops them.
   */
  takeWritten(): Map<AnnotationId, AnnotationId> {
    const written = new Map<AnnotationId, AnnotationId>();
    for (const [id, rowId] of this.placed) {
      if (rowId === undefined) continue;
      written.set(id, rowId);
      this.placed.delete(id);
    }
    return written;
  }

  /** Placed annotations, written or not, go with the next replaceAll. */
  discardPlaced() {
    this.placed.clear();
    this.pending.clear();
  }

  add(annotation: Annotation, commit = true): AnnotationReference {
    if (this.readonly) return this.getReference(annotation.id);
    const reference = super.add(annotation, commit);
    this.placed.set(reference.id, undefined);
    if (commit) this.write(reference.id);
    return reference;
  }

  update(reference: AnnotationReference, annotation: Annotation) {
    if (this.pending.has(reference.id)) super.update(reference, annotation);
  }

  commit(reference: AnnotationReference) {
    if (!this.pending.has(reference.id)) return;
    super.commit(reference);
    this.write(reference.id);
  }

  addProperty(_property: AnnotationPropertySpec) {}

  removeProperty(_identifier: string) {}

  updateProperty(
    _oldProperty: AnnotationPropertySpec,
    _newPropertyValues: Partial<AnnotationPropertySpec>,
  ) {}

  removeAllProperties() {}

  delete(reference: AnnotationReference): Promise<void> {
    const { id } = reference;
    if (this.placed.has(id)) {
      // Only one still being drawn is local; a committed one is the server's.
      if (this.pending.has(id)) this.dropPlaced(id);
      return Promise.resolve();
    }
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

  private write(id: AnnotationId) {
    this.onCreate(this.annotationMap.get(id)!).then(
      (rowId) => {
        if (this.placed.has(id)) this.placed.set(id, rowId);
      },
      () => this.dropPlaced(id),
    );
  }

  private dropPlaced(id: AnnotationId) {
    this.placed.delete(id);
    const reference = this.getReference(id);
    super.delete(reference);
    reference.dispose();
  }
}
