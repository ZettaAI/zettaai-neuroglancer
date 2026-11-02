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
  AnnotationBase,
  AnnotationPropertySpec,
  AnnotationId,
  AnnotationReference,
  RenderedAnnotations,
} from "#src/annotation/index.js";
import {
  AnnotationType,
  LocalAnnotationSource,
} from "#src/annotation/index.js";
import type { WatchableCoordinateSpaceTransform } from "#src/coordinate_transform.js";
import { serializeTableRows } from "#src/datasource/calcada/annotation_tables/table_render_buffer.js";
import type { TableRows } from "#src/datasource/calcada/annotation_tables/table_rows.js";
import {
  annotationOfInstance,
  EMPTY_TABLE_ROWS,
  instanceCount,
  instanceOfId,
  rowOfInstance,
  withoutRow,
} from "#src/datasource/calcada/annotation_tables/table_rows.js";
import type { WatchableValue } from "#src/trackable_value.js";

export interface TableAnnotationSourceOptions {
  isReadonly: () => boolean;
  onDelete: (annotation: Annotation) => Promise<void>;
  /** Writes a placed annotation as a row; resolves to the id the row is drawn under. */
  onCreate: (annotation: Annotation) => Promise<AnnotationId>;
}

/**
 * A local source that takes a whole table at once as columns and writes
 * server-first. A row's annotation is made only when asked for. The rows
 * belong to the server, so NG's edits of them (moving, editing a description,
 * changing the property schema) are ignored; placing a new annotation and
 * deleting one stay. Placed annotations live in `annotationMap`.
 */
export class CalcadaTableAnnotationSource extends LocalAnnotationSource {
  listedInAnnotationList = false;
  private tableRows = EMPTY_TABLE_ROWS("");
  private readonly descriptions = new Map<AnnotationId, string>();
  private readonly onDelete: TableAnnotationSourceOptions["onDelete"];
  private readonly onCreate: TableAnnotationSourceOptions["onCreate"];
  private readonly deletesInFlight = new Map<AnnotationId, Promise<void>>();
  // Placed here and not yet drawn from the server, so carried across
  // showRows; once written, the id its row is drawn under.
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

  get rows(): TableRows {
    return this.tableRows;
  }

  showRows(rows: TableRows) {
    this.ensureUpdated();
    this.tableRows = rows;
    for (const id of this.descriptions.keys()) {
      if (instanceOfId(rows, id) === undefined) this.descriptions.delete(id);
    }
    for (const id of this.annotationMap.keys()) {
      if (!this.placed.has(id)) this.annotationMap.delete(id);
    }
    this.refreshReferences();
    this.changed.dispatch();
  }

  get(id: AnnotationId): Annotation | undefined {
    this.ensureUpdated();
    return this.annotationMap.get(id) ?? this.rowAnnotation(id);
  }

  getReference(id: AnnotationId): AnnotationReference {
    const reference = super.getReference(id);
    reference.value ??= this.get(id) ?? null;
    return reference;
  }

  *[Symbol.iterator](): Generator<Annotation> {
    this.ensureUpdated();
    const rows = this.tableRows;
    for (let instance = 0; instance < instanceCount(rows); ++instance) {
      yield this.described(annotationOfInstance(rows, instance));
    }
    yield* this.annotationMap.values();
  }

  serializeForRender(
    filter: ((annotation: AnnotationBase) => boolean) | undefined,
  ): RenderedAnnotations {
    this.ensureUpdated();
    const placed = [...this.annotationMap.values()];
    if (
      filter !== undefined ||
      placed.some(({ type }) => type === AnnotationType.POLYLINE)
    ) {
      return super.serializeForRender(filter);
    }
    return serializeTableRows(
      this.tableRows,
      placed,
      this.annotationPropertySerializers,
    );
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
    if (this.annotationMap.has(id)) this.annotationMap.set(id, described);
    else this.descriptions.set(id, description);
    const reference = this.references.get(id);
    if (reference === undefined) return;
    reference.value = described;
    reference.changed.dispatch();
  }

  private rowAnnotation(id: AnnotationId): Annotation | undefined {
    const instance = instanceOfId(this.tableRows, id);
    if (instance === undefined) return undefined;
    return this.described(annotationOfInstance(this.tableRows, instance));
  }

  private described(annotation: Annotation): Annotation {
    const description = this.descriptions.get(annotation.id);
    return description === undefined
      ? annotation
      : { ...annotation, description };
  }

  private refreshReferences() {
    for (const reference of this.references.values()) {
      reference.value = this.get(reference.id) ?? null;
      reference.changed.dispatch();
    }
  }

  /**
   * Placed annotations whose rows are written, each with the id its row is
   * drawn under. They are no longer carried: the next showRows drops them.
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

  /** Some placed annotation's row is written and waits to be handed over. */
  hasWritten(): boolean {
    return [...this.placed.values()].some((rowId) => rowId !== undefined);
  }

  /** Placed annotations, written or not, go with the next showRows. */
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
      this.dropRow(reference.id);
    } finally {
      this.deletesInFlight.delete(reference.id);
      reference.dispose();
    }
  }

  private dropRow(id: AnnotationId) {
    const instance = instanceOfId(this.tableRows, id);
    if (instance === undefined) return;
    this.tableRows = withoutRow(
      this.tableRows,
      rowOfInstance(this.tableRows, instance),
    );
    this.descriptions.delete(id);
    this.refreshReferences();
    this.changed.dispatch();
    this.childDeleted.dispatch(id);
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
