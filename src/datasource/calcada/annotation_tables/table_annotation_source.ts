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
  IndexedAnnotations,
  RenderedAnnotations,
} from "#src/annotation/index.js";
import {
  AnnotationType,
  indexAnnotations,
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
import type { RefCounted } from "#src/util/disposable.js";

export interface TableAnnotationSourceOptions {
  isReadonly: () => boolean;
  onDelete: (annotation: Annotation) => Promise<void>;
  /** Writes a placed annotation as a row; resolves to the id the row is drawn under. */
  onCreate: (annotation: Annotation) => Promise<AnnotationId>;
  /** The row's own details in the Selection panel. */
  mountDetails: (
    id: AnnotationId,
    parent: HTMLElement,
    context: RefCounted,
  ) => void;
}

/**
 * A local source that takes a whole table at once as columns and writes
 * server-first. A row's annotation is made only when asked for. The rows
 * belong to the server, so NG's own fields of them are read-only and its edits
 * (moving, changing the property schema) are ignored; a row's payload is edited
 * by `mountDetails`, and placing a new annotation and deleting one stay. Placed
 * annotations live in `annotationMap`.
 */
export class CalcadaTableAnnotationSource extends LocalAnnotationSource {
  private tableRows = EMPTY_TABLE_ROWS("");
  private readonly onDelete: TableAnnotationSourceOptions["onDelete"];
  private readonly onCreate: TableAnnotationSourceOptions["onCreate"];
  private readonly mountDetails: TableAnnotationSourceOptions["mountDetails"];
  private readonly deletesInFlight = new Map<AnnotationId, Promise<void>>();
  // Placed here and not yet drawn from the server, so carried across
  // showRows; once written, the id its row is drawn under.
  private readonly placed = new Map<AnnotationId, AnnotationId | undefined>();

  constructor(
    watchableTransform: WatchableCoordinateSpaceTransform,
    properties: WatchableValue<AnnotationPropertySpec[]>,
    relationships: string[],
    {
      isReadonly,
      onDelete,
      onCreate,
      mountDetails,
    }: TableAnnotationSourceOptions,
  ) {
    super(watchableTransform, properties, relationships);
    this.onDelete = onDelete;
    this.onCreate = onCreate;
    this.mountDetails = mountDetails;
    // The base class declares `readonly` as an own field, which would shadow a getter.
    Object.defineProperty(this, "readonly", { get: isReadonly });
  }

  get rows(): TableRows {
    return this.tableRows;
  }

  showRows(rows: TableRows) {
    this.ensureUpdated();
    this.tableRows = rows;
    for (const id of this.annotationMap.keys()) {
      if (!this.placed.has(id)) this.annotationMap.delete(id);
    }
    this.refreshReferences();
    this.changed.dispatch();
    this.childrenReordered.dispatch();
  }

  /** Rows, then placed annotations; each made only when the list shows it. */
  annotationList(): IndexedAnnotations {
    this.ensureUpdated();
    const rows = this.tableRows;
    const rowInstances = instanceCount(rows);
    const placed = indexAnnotations([...this.annotationMap.values()]);
    return {
      length: rowInstances + placed.length,
      at: (index) =>
        index < rowInstances
          ? annotationOfInstance(rows, index)
          : placed.at(index - rowInstances),
      indexOf: (id) => {
        const instance = instanceOfId(rows, id);
        if (instance !== undefined) return instance;
        const index = placed.indexOf(id);
        return index === undefined ? undefined : rowInstances + index;
      },
    };
  }

  /** Drawn from the table, not placed here. */
  isRow(id: AnnotationId): boolean {
    return instanceOfId(this.tableRows, id) !== undefined;
  }

  /** A row's fields are the server's: only its payload is edited, by mountDetails. */
  isAnnotationReadonly(id: AnnotationId): boolean {
    return this.readonly || this.isRow(id);
  }

  mountAnnotationDetails(
    id: AnnotationId,
    parent: HTMLElement,
    context: RefCounted,
  ) {
    if (this.isRow(id)) this.mountDetails(id, parent, context);
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
      yield annotationOfInstance(rows, instance);
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

  private rowAnnotation(id: AnnotationId): Annotation | undefined {
    const instance = instanceOfId(this.tableRows, id);
    if (instance === undefined) return undefined;
    return annotationOfInstance(this.tableRows, instance);
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
