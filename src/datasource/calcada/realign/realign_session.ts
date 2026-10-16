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
 * @file Local realignment preview: a box and correspondence lines in a local
 * annotation layer, a GPU field computed from them, and the warped section
 * shown as a temporary image layer above the graph's image.
 */

import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type {
  Annotation,
  AxisAlignedBoundingBox,
  Line,
  LocalAnnotationSource,
} from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import { MAIN_BRANCH_ID } from "#src/datasource/calcada/branch_picker_logic.js";
import type {
  ArrowRow,
  RealignStatus,
  RealignSummary,
} from "#src/datasource/calcada/react/realign_panel.js";
import type { FloatTensor } from "#src/datasource/calcada/realign/apply_correspondences_request.js";
import { warpedImageToUint8 } from "#src/datasource/calcada/realign/apply_correspondences_request.js";
import { gpuBackend } from "#src/datasource/calcada/realign/gpu_backend_endpoint.js";
import {
  isReverseArrowKey,
  isSectionToggleKey,
  reversedLine,
  withRejectedFlag,
} from "#src/datasource/calcada/realign/realign_arrows.js";
import type {
  RealignCrop,
  RealignPreview,
} from "#src/datasource/calcada/realign/realign_client.js";
import {
  applyCorrespondences,
  calcadaRefusal,
  RealignError,
  realignErrorMessage,
} from "#src/datasource/calcada/realign/realign_client.js";
import type {
  RealignCommitRow,
  RealignCommitStatus,
} from "#src/datasource/calcada/realign/realign_commit.js";
import {
  appliedFieldKey,
  PartialUndoError,
  commitProgressMessage,
  encodeField,
  latestRequestGate,
  pollCommit,
  residualErrors,
  sectionCount,
} from "#src/datasource/calcada/realign/realign_commit.js";
import type {
  LineEndpoints,
  RealignSelection,
  RealignBox,
} from "#src/datasource/calcada/realign/realign_selection.js";
import type { ReferenceDirection } from "#src/datasource/calcada/realign/realign_selection.js";
import {
  arrowNeedsReversal,
  boxFromCorners,
  DEFAULT_REFERENCE_OFFSET,
  MAX_REFERENCE_OFFSET,
  referenceDirection,
  sectionOf,
  sectionToggleTarget,
  selectCorrespondences,
} from "#src/datasource/calcada/realign/realign_selection.js";
import type { RealignCoordinates } from "#src/datasource/calcada/realign/realign_tools.js";
import {
  RealignArrowTool,
  RealignBoxTool,
  boxSpanInAnnotationZ,
} from "#src/datasource/calcada/realign/realign_tools.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  LayerListSpecification,
  ManagedUserLayer,
} from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { RefCounted } from "#src/util/disposable.js";
import { HttpError } from "#src/util/http_request.js";

export const REALIGN_PREVIEW_LAYER = "realign preview";
export const REALIGN_SEGMENTATION_PREVIEW_LAYER =
  "realign preview (segmentation)";

// Zero is what the preview volume holds outside the box; calcada writes a real
// zero inside it as 1, so only the outside turns transparent.
export const REALIGN_PREVIEW_SHADER = `#uicontrol invlerp normalized
void main() {
  if (getDataValue().value == 0u) {
    emitTransparent();
    return;
  }
  emitGrayscale(toNormalized(getDataValue()));
}
`;

const HTTP_CONFLICT = 409;
const X_AXIS = 0;
const Y_AXIS = 1;
const Z_AXIS = 2;
// A section's middle, where Neuroglancer puts the view when stepping to it.
const SECTION_CENTRE = 0.5;
export const REALIGN_PATCH_LAYER = "realign patch";
export const REALIGN_MAIN_PATCH_LAYER = "realign patch (main)";
// Image layers default to half opacity, which would blend the preview with
// the misaligned section underneath it.
const REALIGN_PREVIEW_OPACITY = 1;
const METRES_PER_NANOMETRE = 1e-9;

/**
 * Where the box and arrows are drawn: annotations of the calcada segmentation
 * layer itself, so no separate layer is ever added or selected.
 */
export interface RealignDrawing {
  /** The calcada layer; the drawing tools are installed on it. */
  readonly layer: UserLayerWithAnnotations;
  readonly annotations: AnnotationLayerState;
  /** How the annotations' coordinates map to global ones and graph voxels. */
  coordinates(): RealignCoordinates | undefined;
}

/** What the session needs from the calcada graph it realigns. */
export interface RealignGraph {
  readonly branchId: WatchableValueInterface<number>;
  /** Graph voxel size in nanometres. */
  readonly resolution: readonly [number, number, number];
  readonly graphServer: {
    fetchRealignSection(
      box: RealignBox,
      branchId: number,
    ): Promise<RealignCrop>;
    putRealignPreview(
      box: RealignBox,
      branchId: number,
      crop: Uint8Array<ArrayBuffer>,
    ): Promise<RealignPreview>;
    putRealignSegmentationPreview(
      box: RealignBox,
      branchId: number,
      field: ArrayBuffer,
    ): Promise<RealignPreview>;
    commitRealign(
      box: RealignBox,
      branchId: number,
      maxShiftPx: number,
      reference: ReferenceDirection,
      field: ArrayBuffer,
    ): Promise<{
      operationId: number;
      sections: number;
      touchedPieces: number;
    }>;
    realignCommitStatus(operationId: number): Promise<RealignCommitStatus>;
    realignPatchSource(branchId: number): Promise<string | undefined>;
    realignCommits(branchId: number): Promise<readonly RealignCommitRow[]>;
    undoRealign(
      operationId: number,
      branchId: number,
    ): Promise<ReadonlyMap<bigint, readonly bigint[]>>;
  };
  /**
   * Retargets any root the commit superseded that is currently visible or
   * selected onto the new roots its pieces moved to, then refreshes the
   * segmentation layer so the rewritten voxels are re-read.
   */
  applyRootChanges(rootMap: ReadonlyMap<bigint, readonly bigint[]>): void;
}

/** The field from the last Apply, valid while the box and arrows are unchanged. */
interface AppliedField {
  readonly selectionKey: string;
  readonly selection: RealignSelection;
  readonly field: FloatTensor;
}

const EMPTY_SUMMARY: RealignSummary = {
  hasBox: false,
  lineCount: 0,
  rejected: [],
  arrows: [],
  onMain: false,
  canCommit: false,
};

export class RealignSession extends RefCounted {
  readonly status = new WatchableValue<RealignStatus>({
    kind: "idle",
    message: "",
  });
  readonly summary = new WatchableValue<RealignSummary>({
    ...EMPTY_SUMMARY,
    unavailableReason: unavailableReason(),
  });
  private watchedSource: LocalAnnotationSource | undefined;
  private inFlight: AbortController | undefined;
  private applied: AppliedField | undefined;
  readonly commits = new WatchableValue<readonly RealignCommitRow[]>([]);
  readonly referenceOffset = new WatchableValue(DEFAULT_REFERENCE_OFFSET);
  private committing = false;
  private undoing = false;
  private readonly patchRequests = latestRequestGate();
  private readonly commitsRequests = latestRequestGate();
  private unwatchSource: (() => void) | undefined;

  constructor(
    private readonly layers: LayerListSpecification,
    private readonly graph: RealignGraph,
    private readonly drawing?: RealignDrawing,
  ) {
    super();
    if (drawing !== undefined) {
      this.watchAnnotations(
        drawing.annotations.source as LocalAnnotationSource,
      );
    }
    this.registerEventListener(window, "keydown", (event: KeyboardEvent) => {
      this.reverseSelectedArrow(event);
      this.toggleSection(event);
    });
    this.registerDisposer(
      this.graph.branchId.changed.add(() => {
        this.refreshSummary();
        void this.refreshPatchLayers();
        void this.refreshCommits();
      }),
    );
    void this.refreshPatchLayers();
    void this.refreshCommits();
  }

  drawBox(): void {
    this.armTool(
      (drawing) =>
        new RealignBoxTool(drawing.layer, drawing.annotations, (z) => {
          const coordinates = drawing.coordinates();
          return coordinates === undefined
            ? [z, z]
            : boxSpanInAnnotationZ(z, this.referenceOffset.value, coordinates);
        }),
      "Ctrl+click two corners of the box on the misaligned section.",
    );
  }

  addCorrespondence(): void {
    this.armTool(
      (drawing) => new RealignArrowTool(drawing.layer, drawing.annotations),
      "Ctrl+click a feature on the box's section, then where it belongs on the reference section (Q switches).",
    );
  }

  async apply(): Promise<void> {
    const backend = gpuBackend();
    if ("unavailableReason" in backend) {
      this.setError(backend.unavailableReason);
      return;
    }
    const selection = this.currentSelection();
    if (selection === undefined) {
      this.setError("Draw a box first.");
      return;
    }
    if (selection.lines.length === 0) {
      this.setError(
        "Add at least one correspondence from the box's section to the reference section.",
      );
      return;
    }
    const { box, lines } = selection;
    const branchId = this.graph.branchId.value;
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const { signal } = controller;
    try {
      this.setWorking("Reading the sections…");
      const [crop, referenceCrop] = await Promise.all([
        this.graph.graphServer.fetchRealignSection(box, branchId),
        this.graph.graphServer.fetchRealignSection(
          { ...box, z: selection.referenceSection },
          branchId,
        ),
      ]);
      if (signal.aborted) return;
      this.setWorking("Computing the field…");
      const result = await applyCorrespondences(
        backend.endpoint,
        crop,
        lines,
        fetch,
        signal,
        referenceCrop,
      );
      if (result.warpedImage === undefined) {
        throw new RealignError("failed", "no warped image returned");
      }
      this.setWorking("Writing the preview…");
      const preview = await this.graph.graphServer.putRealignPreview(
        box,
        branchId,
        warpedImageToUint8(result.warpedImage),
      );
      if (signal.aborted) return;
      this.applied = {
        selectionKey: appliedFieldKey(selection, branchId),
        selection,
        field: result.field,
      };
      this.refreshSummary();
      this.showPreview(preview.layerSource);
      const segmentationNote = await this.previewSegmentation(
        box,
        branchId,
        result.field,
        signal,
      );
      if (signal.aborted) return;
      this.status.value = {
        kind: "done",
        message: `Preview updated — press Q to switch ${box.z} ↔ ${selection.referenceSection}.${segmentationNote}`,
      };
    } catch (error) {
      if (signal.aborted) return;
      this.setError(realignErrorMessage(calcadaError(error)));
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }

  /** Abandons a running Apply, including one waiting on the Google login. */
  cancel(): void {
    if (this.inFlight === undefined) return;
    this.inFlight.abort();
    this.inFlight = undefined;
    this.status.value = { kind: "idle", message: "Realign cancelled." };
  }

  clearPreview(): void {
    this.cancel();
    this.removePreviewLayer();
    this.status.value = { kind: "idle", message: "" };
  }

  private removePreviewLayer(): void {
    for (const name of [
      REALIGN_PREVIEW_LAYER,
      REALIGN_SEGMENTATION_PREVIEW_LAYER,
    ]) {
      const preview = this.findManagedLayer(name);
      if (preview !== undefined) {
        this.layers.rootLayers.removeManagedLayer(preview);
      }
    }
  }

  /**
   * Shows the box's section of the segmentation warped by the field. The
   * image preview stands without it: a failure only adds a note to the status.
   */
  private async previewSegmentation(
    box: RealignBox,
    branchId: number,
    field: FloatTensor,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      this.setWorking("Previewing the segmentation…");
      const preview =
        await this.graph.graphServer.putRealignSegmentationPreview(
          box,
          branchId,
          await encodeField(field),
        );
      if (!signal.aborted) this.showSegmentationPreview(preview.layerSource);
      return "";
    } catch (error) {
      return ` The segmentation preview failed: ${realignErrorMessage(calcadaError(error))}`;
    }
  }

  plannedSections(maxShiftPx: number): number | undefined {
    return this.applied && sectionCount(this.applied.field, maxShiftPx);
  }

  async commit(maxShiftPx: number): Promise<void> {
    const applied = this.applied;
    const branchId = this.graph.branchId.value;
    if (
      applied === undefined ||
      branchId === MAIN_BRANCH_ID ||
      this.committing
    ) {
      return;
    }
    this.committing = true;
    this.refreshSummary();
    this.status.value = { kind: "committing", message: "Starting the commit…" };
    try {
      const { operationId, sections, touchedPieces } =
        await this.graph.graphServer.commitRealign(
          applied.selection.box,
          branchId,
          maxShiftPx,
          referenceDirection(
            applied.selection.referenceSection - applied.selection.box.z,
          ),
          await encodeField(applied.field),
        );
      // The branch now carries (or will carry) this warp: committing the same
      // field again would warp the already warped image.
      this.applied = undefined;
      const outcome = await pollCommit(
        () => this.graph.graphServer.realignCommitStatus(operationId),
        {
          onProgress: ({ sectionsDone, sectionsTotal }) => {
            this.status.value = {
              kind: "committing",
              message: commitProgressMessage(
                sectionsDone ?? 0,
                sectionsTotal ?? sections,
                touchedPieces,
              ),
            };
          },
          isStopped: () => this.wasDisposed === true,
        },
      );
      if (this.wasDisposed) return;
      if (outcome.status === "failed") {
        this.setError(`Commit failed: ${outcome.error ?? "unknown error"}`);
        return;
      }
      this.removePreviewLayer();
      this.graph.applyRootChanges(outcome.rootMap ?? new Map());
      await this.refreshPatchLayers();
      this.status.value = {
        kind: "done",
        message: `Changes ${sections} sections and cuts ${touchedPieces} pieces on this branch.`,
      };
    } catch (error) {
      this.setError(realignErrorMessage(await calcadaRefusal(error)));
    } finally {
      this.committing = false;
      this.refreshSummary();
      void this.refreshCommits();
    }
  }

  async undo(operationId: number): Promise<void> {
    if (this.undoing) return;
    this.undoing = true;
    const branchId = this.graph.branchId.value;
    this.setWorking(`Undoing realign #${operationId}…`);
    try {
      const rootMap = await this.graph.graphServer.undoRealign(
        operationId,
        branchId,
      );
      if (this.wasDisposed) return;
      this.graph.applyRootChanges(rootMap);
      this.status.value = {
        kind: "done",
        message: `Realign #${operationId} undone.`,
      };
    } catch (error) {
      if (error instanceof PartialUndoError && !this.wasDisposed) {
        this.graph.applyRootChanges(error.rootMap);
      }
      this.setError(realignErrorMessage(await calcadaRefusal(error)));
    } finally {
      this.undoing = false;
    }
    if (this.wasDisposed) return;
    await Promise.all([this.refreshPatchLayers(), this.refreshCommits()]);
  }

  focusArrow(id: string): void {
    const { drawing } = this;
    const line = this.watchedSource?.get(id);
    if (drawing === undefined || line === undefined || !isLine(line)) return;
    const coordinates = drawing.coordinates();
    if (coordinates !== undefined) {
      const { globalPosition } = this.layers.root;
      const global = coordinates.toGlobal(line.pointA);
      const position = globalPosition.value;
      position[X_AXIS] = global[X_AXIS];
      position[Y_AXIS] = global[Y_AXIS];
      globalPosition.changed.dispatch();
    }
    drawing.layer.selectAnnotation(drawing.annotations, id, true);
  }

  removeAllArrows(): void {
    const source = this.watchedSource;
    if (source === undefined) return;
    for (const line of [...source].filter(isLine)) {
      const reference = source.getReference(line.id);
      try {
        source.delete(reference);
      } finally {
        reference.dispose();
      }
    }
  }

  /**
   * Shows main's patch volume directly above the image and, on a branch, the
   * branch's above it; a volume not written yet has no layer.
   */
  private async refreshPatchLayers(): Promise<void> {
    const isCurrent = this.patchRequests.begin();
    const branchId = this.graph.branchId.value;
    const { graphServer } = this.graph;
    let sources: (string | undefined)[];
    try {
      sources = await Promise.all([
        graphServer.realignPatchSource(MAIN_BRANCH_ID),
        branchId === MAIN_BRANCH_ID
          ? undefined
          : graphServer.realignPatchSource(branchId),
      ]);
    } catch (error) {
      if (isCurrent()) {
        this.setError(
          `Could not load the realign patch: ${realignErrorMessage(error)}`,
        );
      }
      return;
    }
    // A branch switch while this was in flight started a newer request, whose
    // answer is the one that matters.
    if (this.wasDisposed || !isCurrent()) return;
    const layerNames = [REALIGN_MAIN_PATCH_LAYER, REALIGN_PATCH_LAYER];
    for (const name of layerNames) {
      const existing = this.findManagedLayer(name);
      if (existing !== undefined) {
        this.layers.rootLayers.removeManagedLayer(existing);
      }
    }
    let index = this.previewIndex();
    sources.forEach((source, layer) => {
      if (source === undefined) return;
      this.layers.add(
        makeLayer(this.layers, layerNames[layer], {
          type: "image",
          source,
          shader: REALIGN_PREVIEW_SHADER,
          opacity: REALIGN_PREVIEW_OPACITY,
        }),
        index,
      );
      if (index !== undefined) index++;
    });
  }

  private async refreshCommits(): Promise<void> {
    const isCurrent = this.commitsRequests.begin();
    let commits: readonly RealignCommitRow[] = [];
    try {
      commits = await this.graph.graphServer.realignCommits(
        this.graph.branchId.value,
      );
    } catch (error) {
      if (isCurrent()) {
        this.setError(
          `Could not list this branch's realigns: ${realignErrorMessage(await calcadaRefusal(error))}`,
        );
      }
    }
    if (this.wasDisposed || !isCurrent()) return;
    this.commits.value = commits;
  }

  override disposed(): void {
    this.inFlight?.abort();
    this.unwatchSource?.();
    super.disposed();
  }

  private armTool(
    makeTool: (drawing: RealignDrawing) => RealignBoxTool | RealignArrowTool,
    hint: string,
  ): void {
    const { drawing } = this;
    if (drawing === undefined) return;
    // The viewer sends a Ctrl+click to the selected layer's tool.
    const host = this.layers.rootLayers.managedLayers.find(
      (managed) => managed.layer === drawing.layer,
    );
    if (host !== undefined) this.layers.root.selectedLayer.layer = host;
    drawing.layer.tool.value = makeTool(drawing);
    this.status.value = { kind: "idle", message: hint };
  }

  private findManagedLayer(name: string): ManagedUserLayer | undefined {
    return this.layers.rootLayers.managedLayers.find(
      (managed) => managed.name === name,
    );
  }

  private watchAnnotations(source: LocalAnnotationSource): void {
    if (this.watchedSource === source) return;
    this.unwatchSource?.();
    this.watchedSource = source;
    const refresh = () => this.refreshSummary();
    const offs = [
      source.childAdded.add(refresh),
      source.childUpdated.add(refresh),
      source.childDeleted.add(refresh),
      source.childCommitted.add((annotationId) => {
        this.keepOnlyBox(source, annotationId);
        this.orientArrow(source, annotationId);
        refresh();
      }),
    ];
    this.unwatchSource = () => {
      for (const off of offs) off();
    };
    refresh();
  }

  /** A realign has one box: a newly committed box replaces the earlier one. */
  private keepOnlyBox(source: LocalAnnotationSource, committedId: string) {
    const committed = source.get(committedId);
    if (committed === undefined || !isBox(committed)) return;
    const earlier = [...source].filter(
      (annotation) => isBox(annotation) && annotation.id !== committedId,
    );
    // Deferred: this runs inside the tool's trigger(), and deleting while it
    // still holds the in-progress annotation would re-enter it.
    queueMicrotask(() => {
      for (const annotation of earlier) {
        const reference = source.getReference(annotation.id);
        try {
          source.delete(reference);
        } finally {
          reference.dispose();
        }
      }
    });
  }

  /** Turns a new arrow round when it was drawn from the section below up. */
  private orientArrow(source: LocalAnnotationSource, committedId: string) {
    const committed = source.get(committedId);
    const box = [...source].find(isBox);
    if (committed === undefined || !isLine(committed) || box === undefined) {
      return;
    }
    const toVoxels = this.toGraphVoxels();
    const offset = this.referenceOffset.value;
    const { z } = boxFromCorners(
      toVoxels(box.pointA),
      toVoxels(box.pointB),
      offset,
    );
    if (
      !arrowNeedsReversal(
        toVoxels(committed.pointA),
        toVoxels(committed.pointB),
        z,
        z + offset,
      )
    ) {
      return;
    }
    // Deferred for the same reason as keepOnlyBox.
    queueMicrotask(() => {
      const line = source.get(committedId);
      if (line === undefined || !isLine(line)) return;
      const reference = source.getReference(committedId);
      try {
        source.update(reference, reversedLine(line));
      } finally {
        reference.dispose();
      }
    });
  }

  private currentSelection() {
    const source = this.watchedSource;
    if (source === undefined) return undefined;
    const annotations = [...source];
    const box = annotations.find(isBox);
    if (box === undefined) return undefined;
    const toVoxels = this.toGraphVoxels();
    const lines: LineEndpoints[] = annotations.filter(isLine).map((line) => ({
      id: line.id,
      pointA: toVoxels(line.pointA),
      pointB: toVoxels(line.pointB),
    }));
    const offset = this.referenceOffset.value;
    return selectCorrespondences(
      boxFromCorners(toVoxels(box.pointA), toVoxels(box.pointB), offset),
      lines,
      offset,
    );
  }

  /**
   * Moves the reference to `offset` sections from the moving one, and stretches
   * the box over the new pair so it stays visible on both.
   */
  setReferenceOffset(offset: number): void {
    if (
      !Number.isInteger(offset) ||
      offset === 0 ||
      Math.abs(offset) > MAX_REFERENCE_OFFSET
    ) {
      return;
    }
    const source = this.watchedSource;
    const box = source === undefined ? undefined : [...source].find(isBox);
    const coordinates = this.drawing?.coordinates();
    if (
      source !== undefined &&
      box !== undefined &&
      coordinates !== undefined
    ) {
      const toVoxels = this.toGraphVoxels();
      const { z } = boxFromCorners(
        toVoxels(box.pointA),
        toVoxels(box.pointB),
        this.referenceOffset.value,
      );
      const ends = [
        coordinates.graphVoxelZToAnnotationZ(Math.min(z, z + offset)),
        coordinates.graphVoxelZToAnnotationZ(Math.max(z, z + offset) + 1),
      ];
      const pointA = box.pointA.slice();
      const pointB = box.pointB.slice();
      pointA[Z_AXIS] = Math.min(...ends);
      pointB[Z_AXIS] = Math.max(...ends);
      const reference = source.getReference(box.id);
      try {
        source.update(reference, { ...box, pointA, pointB });
      } finally {
        reference.dispose();
      }
    }
    this.referenceOffset.value = offset;
    this.refreshSummary();
  }

  /** Q: jumps the view between the moving and the reference section. */
  private toggleSection(event: KeyboardEvent): void {
    if (!isSectionToggleKey(event) || isTextEntry(event.target)) return;
    const selection = this.currentSelection();
    if (selection === undefined) return;
    event.preventDefault();
    const { globalPosition, coordinateSpace } = this.layers.root;
    const metresPerVoxel = this.graph.resolution[Z_AXIS] * METRES_PER_NANOMETRE;
    const globalUnitsPerVoxel =
      metresPerVoxel / coordinateSpace.value.scales[Z_AXIS];
    const position = globalPosition.value;
    const target = sectionToggleTarget(
      sectionOf(position[Z_AXIS] / globalUnitsPerVoxel),
      selection.box.z,
      selection.referenceSection,
    );
    position[Z_AXIS] = (target + SECTION_CENTRE) * globalUnitsPerVoxel;
    globalPosition.changed.dispatch();
  }

  /** Flags rejected lines so the arrow shader draws them red. */
  private markRejectedArrows(rejectedIds: ReadonlySet<string>): void {
    const source = this.watchedSource;
    if (source === undefined) return;
    for (const line of [...source].filter(isLine)) {
      const updated = withRejectedFlag(line, rejectedIds.has(line.id));
      if (updated === undefined) continue;
      const reference = source.getReference(line.id);
      try {
        source.update(reference, updated);
      } finally {
        reference.dispose();
      }
    }
  }

  private reverseSelectedArrow(event: KeyboardEvent): void {
    if (!isReverseArrowKey(event) || isTextEntry(event.target)) return;
    const { drawing } = this;
    const source = this.watchedSource;
    if (
      drawing === undefined ||
      source === undefined ||
      this.layers.root.selectedLayer.layer?.layer !== drawing.layer
    ) {
      return;
    }
    const selected = drawing.layer.getSelectedAnnotationContext();
    const line =
      selected?.annotationLayerState === drawing.annotations
        ? source.get(selected.annotationId)
        : undefined;
    if (line === undefined || !isLine(line)) return;
    event.preventDefault();
    const reference = source.getReference(line.id);
    try {
      source.update(reference, reversedLine(line));
    } finally {
      reference.dispose();
    }
  }

  private refreshSummary(): void {
    const selection = this.currentSelection();
    this.markRejectedArrows(new Set(selection?.rejected.map(({ id }) => id)));
    if (
      this.applied !== undefined &&
      (selection === undefined ||
        appliedFieldKey(selection, this.graph.branchId.value) !==
          this.applied.selectionKey)
    ) {
      this.applied = undefined;
    }
    const applied = this.applied;
    const residuals = new Map<string, number>();
    if (applied !== undefined) {
      const errors = residualErrors(applied.field, applied.selection.lines);
      applied.selection.lines.forEach(({ id }, index) =>
        residuals.set(id, errors[index]),
      );
    }
    this.summary.value = {
      hasBox: selection !== undefined,
      boxSection: selection?.box.z,
      referenceSection: selection?.referenceSection,
      lineCount: selection?.lines.length ?? 0,
      rejected: selection?.rejected ?? [],
      unavailableReason: unavailableReason(),
      arrows: this.arrowRows(selection, residuals),
      residualMeanPx:
        residuals.size === 0
          ? undefined
          : [...residuals.values()].reduce((sum, value) => sum + value, 0) /
            residuals.size,
      onMain: this.graph.branchId.value === MAIN_BRANCH_ID,
      canCommit: applied !== undefined && !this.committing,
    };
  }

  private arrowRows(
    selection: RealignSelection | undefined,
    residuals: ReadonlyMap<string, number>,
  ): ArrowRow[] {
    const source = this.watchedSource;
    if (source === undefined) return [];
    const accepted = new Map(selection?.lines.map((line) => [line.id, line]));
    const rejected = new Map(
      selection?.rejected.map(({ id, reason }) => [id, reason]),
    );
    const toVoxels = this.toGraphVoxels();
    return [...source].filter(isLine).map((line) => {
      const cropLine = accepted.get(line.id);
      const [tailX, tailY, tailZ] = toVoxels(line.pointA);
      const [headX, headY, headZ] = toVoxels(line.pointB);
      return {
        id: line.id,
        sections: [sectionOf(tailZ), sectionOf(headZ)] as const,
        lengthPx:
          cropLine === undefined
            ? Math.hypot(headX - tailX, headY - tailY)
            : Math.hypot(
                cropLine.start[0] - cropLine.end[0],
                cropLine.start[1] - cropLine.end[1],
              ),
        residualPx: residuals.get(line.id),
        rejected: rejected.get(line.id),
      };
    });
  }

  /** Annotation coordinates to graph voxels, through the layer's transform. */
  private toGraphVoxels(): (point: Float32Array) => number[] {
    const coordinates = this.drawing?.coordinates();
    return (point) =>
      coordinates === undefined
        ? Array.from(point)
        : coordinates.toGraphVoxels(point);
  }

  private showPreview(source: string): void {
    const managed = makeLayer(this.layers, REALIGN_PREVIEW_LAYER, {
      type: "image",
      source,
      shader: REALIGN_PREVIEW_SHADER,
      opacity: REALIGN_PREVIEW_OPACITY,
    });
    const previous = this.findManagedLayer(REALIGN_PREVIEW_LAYER);
    if (previous !== undefined) {
      this.layers.rootLayers.removeManagedLayer(previous);
    }
    this.layers.add(managed, this.previewIndex());
  }

  private showSegmentationPreview(source: string): void {
    const previous = this.findManagedLayer(REALIGN_SEGMENTATION_PREVIEW_LAYER);
    if (previous !== undefined) {
      this.layers.rootLayers.removeManagedLayer(previous);
    }
    const managed = makeLayer(this.layers, REALIGN_SEGMENTATION_PREVIEW_LAYER, {
      type: "segmentation",
      source,
    });
    this.layers.add(managed, this.segmentationPreviewIndex());
  }

  /** Directly above the calcada layer, or on top when it is not in the list. */
  private segmentationPreviewIndex(): number | undefined {
    const index = this.layers.rootLayers.managedLayers.findIndex(
      (managed) => managed.layer === this.drawing?.layer,
    );
    return index === -1 ? undefined : index + 1;
  }

  /** Directly above the graph's image, or on top when there is none. */
  private previewIndex(): number | undefined {
    const index = this.layers.rootLayers.managedLayers.findIndex(
      (managed) => managed.layer instanceof ImageUserLayer,
    );
    return index === -1 ? undefined : index + 1;
  }

  private setWorking(message: string): void {
    this.status.value = { kind: "working", message };
  }

  private setError(message: string): void {
    this.status.value = { kind: "error", message };
  }
}

function unavailableReason(): string | undefined {
  const backend = gpuBackend();
  return "unavailableReason" in backend ? backend.unavailableReason : undefined;
}

function isBox(annotation: Annotation): annotation is AxisAlignedBoundingBox {
  return annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Gives a realign layer made before arrows existed the arrow shader and flag. */
function isLine(annotation: Annotation): annotation is Line {
  return annotation.type === AnnotationType.LINE;
}

function calcadaError(error: unknown): unknown {
  if (error instanceof HttpError && error.status === HTTP_CONFLICT) {
    return new RealignError("no-image", error.message);
  }
  return error;
}
