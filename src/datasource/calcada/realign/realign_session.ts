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

import type {
  Annotation,
  AxisAlignedBoundingBox,
  Line,
  LocalAnnotationSource,
} from "#src/annotation/index.js";
import {
  AnnotationType,
  parseAnnotationPropertySpecs,
} from "#src/annotation/index.js";
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
  REALIGN_ARROW_PROPERTIES,
  REALIGN_ARROW_SHADER,
  REJECTED_PROPERTY_INDEX,
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
import {
  arrowNeedsReversal,
  boxFromCorners,
  sectionOf,
  selectCorrespondences,
} from "#src/datasource/calcada/realign/realign_selection.js";
import {
  globalSectionSpan,
  RealignArrowTool,
  RealignBoxTool,
} from "#src/datasource/calcada/realign/realign_tools.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  LayerListSpecification,
  ManagedUserLayer,
  UserLayer,
} from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { HttpError } from "#src/util/http_request.js";

export const REALIGN_ANNOTATION_LAYER = "realign";
export const REALIGN_PREVIEW_LAYER = "realign preview";

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
export const REALIGN_PATCH_LAYER = "realign patch";
export const REALIGN_MAIN_PATCH_LAYER = "realign patch (main)";
// Image layers default to half opacity, which would blend the preview with
// the misaligned section underneath it.
const REALIGN_PREVIEW_OPACITY = 1;
const METRES_PER_NANOMETRE = 1e-9;

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
    commitRealign(
      box: RealignBox,
      branchId: number,
      maxShiftPx: number,
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
  private committing = false;
  private undoing = false;
  private readonly patchRequests = latestRequestGate();
  private readonly commitsRequests = latestRequestGate();
  private unwatchSource: (() => void) | undefined;

  /**
   * @param toolLayer - The layer whose Realign tab drives the session. The
   *   drawing tools are installed on it, so the selection stays there.
   */
  constructor(
    private readonly layers: LayerListSpecification,
    private readonly graph: RealignGraph,
    private readonly toolLayer?: UserLayer,
  ) {
    super();
    const existing = this.findAnnotationLayer();
    if (existing !== undefined) this.whenAnnotationsReady(existing);
    this.registerEventListener(window, "keydown", (event: KeyboardEvent) =>
      this.reverseSelectedArrow(event),
    );
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
    const { scales } = this.layers.root.coordinateSpace.value;
    const resolutionZ = this.graph.resolution[Z_AXIS];
    this.armTool(
      (layer) =>
        new RealignBoxTool(layer, (globalZ) =>
          globalSectionSpan(globalZ, scales[Z_AXIS], resolutionZ),
        ),
      "Ctrl+click two corners of the box on the misaligned section.",
    );
  }

  addCorrespondence(): void {
    this.armTool(
      (layer) => new RealignArrowTool(layer, {}),
      "Ctrl+click a feature on the box's section, then where it belongs on the section below.",
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
        "Add at least one correspondence from the box's section to the one below.",
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
      this.setWorking("Reading the section…");
      const crop = await this.graph.graphServer.fetchRealignSection(
        box,
        branchId,
      );
      if (signal.aborted) return;
      this.setWorking("Computing the field…");
      const result = await applyCorrespondences(
        backend.endpoint,
        crop,
        lines,
        fetch,
        signal,
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
      this.status.value = {
        kind: "done",
        message: `Preview updated — scroll ${box.z - 1} ↔ ${box.z} to compare.`,
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
    const preview = this.findManagedLayer(REALIGN_PREVIEW_LAYER);
    if (preview !== undefined) {
      this.layers.rootLayers.removeManagedLayer(preview);
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
    const managed = this.findAnnotationLayer();
    const line = this.watchedSource?.get(id);
    if (managed === undefined || line === undefined || !isLine(line)) return;
    const { globalPosition } = this.layers.root;
    const position = globalPosition.value;
    position[X_AXIS] = line.pointA[X_AXIS];
    position[Y_AXIS] = line.pointA[Y_AXIS];
    globalPosition.changed.dispatch();
    const layer = managed.layer as AnnotationUserLayer;
    const [annotationLayerState] = layer.annotationStates.states;
    if (annotationLayerState !== undefined) {
      layer.selectAnnotation(annotationLayerState, id, true);
    }
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
    makeTool: (layer: AnnotationUserLayer) => RealignBoxTool | RealignArrowTool,
    hint: string,
  ): void {
    const managed = this.findOrCreateAnnotationLayer();
    if (this.toolLayer === undefined) {
      this.layers.root.selectedLayer.layer = managed;
    }
    this.whenAnnotationsReady(managed, (layer) => {
      (this.toolLayer ?? layer).tool.value = makeTool(layer);
      this.status.value = { kind: "idle", message: hint };
    });
  }

  private findManagedLayer(name: string): ManagedUserLayer | undefined {
    return this.layers.rootLayers.managedLayers.find(
      (managed) => managed.name === name,
    );
  }

  private findAnnotationLayer(): ManagedUserLayer | undefined {
    const managed = this.findManagedLayer(REALIGN_ANNOTATION_LAYER);
    return managed?.layer instanceof AnnotationUserLayer ? managed : undefined;
  }

  private findOrCreateAnnotationLayer(): ManagedUserLayer {
    const existing = this.findAnnotationLayer();
    if (existing !== undefined) {
      existing.setVisible(true);
      return existing;
    }
    const managed = makeLayer(this.layers, REALIGN_ANNOTATION_LAYER, {
      type: "annotation",
      source: "local://annotations",
      shader: REALIGN_ARROW_SHADER,
      annotationProperties: REALIGN_ARROW_PROPERTIES,
    });
    this.layers.add(managed);
    return managed;
  }

  /**
   * Runs `ready` once the layer's local annotation source exists — a tick
   * after the layer is added — and starts following its annotations.
   */
  private whenAnnotationsReady(
    managed: ManagedUserLayer,
    ready?: (layer: AnnotationUserLayer) => void,
  ): void {
    const tryNow = () => {
      const layer = managed.layer;
      if (
        !(layer instanceof AnnotationUserLayer) ||
        layer.localAnnotations === undefined
      ) {
        return false;
      }
      giveArrowLook(layer);
      this.watchAnnotations(layer.localAnnotations);
      ready?.(layer);
      return true;
    };
    if (tryNow()) return;
    const stop = () => {
      offReady();
      offChanged();
    };
    const check = () => {
      if (tryNow()) stop();
    };
    const offReady = managed.readyStateChanged.add(check);
    const offChanged = managed.layerChanged.add(check);
    this.registerDisposer(stop);
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
    const toVoxels = this.globalToGraphVoxels();
    const { z } = boxFromCorners(toVoxels(box.pointA), toVoxels(box.pointB));
    if (
      !arrowNeedsReversal(
        toVoxels(committed.pointA),
        toVoxels(committed.pointB),
        z,
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
    const toVoxels = this.globalToGraphVoxels();
    const lines: LineEndpoints[] = annotations.filter(isLine).map((line) => ({
      id: line.id,
      pointA: toVoxels(line.pointA),
      pointB: toVoxels(line.pointB),
    }));
    return selectCorrespondences(
      boxFromCorners(toVoxels(box.pointA), toVoxels(box.pointB)),
      lines,
    );
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
    const managed = this.findAnnotationLayer();
    const source = this.watchedSource;
    const selectedLayer = this.layers.root.selectedLayer.layer;
    const onRealignLayer =
      selectedLayer === managed ||
      (this.toolLayer !== undefined && selectedLayer?.layer === this.toolLayer);
    if (managed === undefined || source === undefined || !onRealignLayer) {
      return;
    }
    const layer = managed.layer as AnnotationUserLayer;
    const selected = layer.getSelectedAnnotationContext();
    const line =
      selected === undefined ? undefined : source.get(selected.annotationId);
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
    const toVoxels = this.globalToGraphVoxels();
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

  /**
   * Local annotations live in the global coordinate space; realign boxes are
   * in graph voxels, so go through nanometres.
   */
  private globalToGraphVoxels(): (point: Float32Array) => number[] {
    const { scales } = this.layers.root.coordinateSpace.value;
    const { resolution } = this.graph;
    return (point) =>
      Array.from(
        point,
        (value, axis) =>
          (value * scales[axis]) / METRES_PER_NANOMETRE / resolution[axis],
      );
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
function giveArrowLook(layer: AnnotationUserLayer): void {
  const source = layer.localAnnotations!;
  const rejectedId = REALIGN_ARROW_PROPERTIES[REJECTED_PROPERTY_INDEX].id;
  if (
    !source.properties.value.some(({ identifier }) => identifier === rejectedId)
  ) {
    source.properties.value = parseAnnotationPropertySpecs(
      REALIGN_ARROW_PROPERTIES,
    );
  }
  if (layer.annotationDisplayState.shader.value !== REALIGN_ARROW_SHADER) {
    layer.annotationDisplayState.shader.value = REALIGN_ARROW_SHADER;
  }
}

function isLine(annotation: Annotation): annotation is Line {
  return annotation.type === AnnotationType.LINE;
}

function calcadaError(error: unknown): unknown {
  if (error instanceof HttpError && error.status === HTTP_CONFLICT) {
    return new RealignError("no-image", error.message);
  }
  return error;
}
