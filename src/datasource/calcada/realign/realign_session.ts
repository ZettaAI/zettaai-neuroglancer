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
import { AnnotationType } from "#src/annotation/index.js";
import type {
  RealignStatus,
  RealignSummary,
} from "#src/datasource/calcada/react/realign_panel.js";
import { warpedImageToUint8 } from "#src/datasource/calcada/realign/apply_correspondences_request.js";
import { gpuBackend } from "#src/datasource/calcada/realign/gpu_backend_endpoint.js";
import type {
  RealignCrop,
  RealignPreview,
} from "#src/datasource/calcada/realign/realign_client.js";
import {
  applyCorrespondences,
  RealignError,
  realignErrorMessage,
} from "#src/datasource/calcada/realign/realign_client.js";
import type {
  LineEndpoints,
  RealignBox,
} from "#src/datasource/calcada/realign/realign_selection.js";
import {
  boxFromCorners,
  selectCorrespondences,
} from "#src/datasource/calcada/realign/realign_selection.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  LayerListSpecification,
  ManagedUserLayer,
} from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { PlaceBoundingBoxTool, PlaceLineTool } from "#src/ui/annotations.js";
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
  };
}

const EMPTY_SUMMARY: RealignSummary = {
  hasBox: false,
  lineCount: 0,
  rejected: [],
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
  private unwatchSource: (() => void) | undefined;

  constructor(
    private readonly layers: LayerListSpecification,
    private readonly graph: RealignGraph,
  ) {
    super();
    const existing = this.findAnnotationLayer();
    if (existing !== undefined) this.whenAnnotationsReady(existing);
  }

  drawBox(): void {
    this.armTool(
      (layer) => new PlaceBoundingBoxTool(layer, {}),
      "Ctrl+click two corners of the box on the misaligned section.",
    );
  }

  addCorrespondence(): void {
    this.armTool(
      (layer) => new PlaceLineTool(layer, {}),
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
    const preview = this.findManagedLayer(REALIGN_PREVIEW_LAYER);
    if (preview !== undefined) {
      this.layers.rootLayers.removeManagedLayer(preview);
    }
    this.status.value = { kind: "idle", message: "" };
  }

  override disposed(): void {
    this.inFlight?.abort();
    this.unwatchSource?.();
    super.disposed();
  }

  private armTool(
    makeTool: (
      layer: AnnotationUserLayer,
    ) => PlaceBoundingBoxTool | PlaceLineTool,
    hint: string,
  ): void {
    const managed = this.findOrCreateAnnotationLayer();
    this.layers.root.selectedLayer.layer = managed;
    this.whenAnnotationsReady(managed, (layer) => {
      layer.tool.value = makeTool(layer);
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

  private refreshSummary(): void {
    const selection = this.currentSelection();
    this.summary.value = {
      hasBox: selection !== undefined,
      lineCount: selection?.lines.length ?? 0,
      rejected: selection?.rejected ?? [],
      unavailableReason: unavailableReason(),
    };
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

function isLine(annotation: Annotation): annotation is Line {
  return annotation.type === AnnotationType.LINE;
}

function calcadaError(error: unknown): unknown {
  if (error instanceof HttpError && error.status === HTTP_CONFLICT) {
    return new RealignError("no-image", error.message);
  }
  return error;
}
