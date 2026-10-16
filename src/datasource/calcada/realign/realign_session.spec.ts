import { describe, expect, it, vi } from "vitest";
import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type {
  Annotation,
  AxisAlignedBoundingBox,
} from "#src/annotation/index.js";
import {
  AnnotationType,
  LocalAnnotationSource,
  parseAnnotationPropertySpecs,
} from "#src/annotation/index.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import { REALIGN_ARROW_PROPERTIES } from "#src/datasource/calcada/realign/realign_arrows.js";
import { PartialUndoError } from "#src/datasource/calcada/realign/realign_commit.js";
import type { RealignGraph } from "#src/datasource/calcada/realign/realign_session.js";
import {
  REALIGN_PREVIEW_LAYER,
  REALIGN_SEGMENTATION_PREVIEW_LAYER,
  RealignSession,
} from "#src/datasource/calcada/realign/realign_session.js";
import { RealignCoordinates } from "#src/datasource/calcada/realign/realign_tools.js";
import type { LayerListSpecification } from "#src/layer/index.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";

const BRANCH_ID = 3;

function emptyLayers(): LayerListSpecification {
  return {
    rootLayers: { managedLayers: [], removeManagedLayer: vi.fn() },
    add: vi.fn(),
  } as unknown as LayerListSpecification;
}

function makeSession(undoRealign: RealignGraph["graphServer"]["undoRealign"]) {
  const applyRootChanges = vi.fn();
  const graph = {
    branchId: new WatchableValue(BRANCH_ID),
    resolution: [16, 16, 40],
    graphServer: {
      realignPatchSource: vi.fn(async () => undefined),
      realignCommits: vi.fn(async () => []),
      undoRealign: vi.fn(undoRealign),
    },
    applyRootChanges,
  } as unknown as RealignGraph;
  return {
    session: new RealignSession(emptyLayers(), graph),
    graphServer: graph.graphServer,
    applyRootChanges,
  };
}

describe("RealignSession.undo", () => {
  it("ignores a second undo while one is running", async () => {
    let finish!: (rootMap: Map<bigint, bigint[]>) => void;
    const { session, graphServer } = makeSession(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = session.undo(12);
    await session.undo(12);
    expect(graphServer.undoRealign).toHaveBeenCalledTimes(1);
    finish(new Map());
    await first;
    const again = session.undo(12);
    expect(graphServer.undoRealign).toHaveBeenCalledTimes(2);
    finish(new Map());
    await again;
  });

  it("applies the root map of a partial undo, then shows the server's reason", async () => {
    const rootMap = new Map([[5n, [1n]]]);
    const { session, applyRootChanges } = makeSession(async () => {
      throw new PartialUndoError(
        "voxels partly restored; run undo again",
        rootMap,
      );
    });
    await session.undo(12);
    expect(applyRootChanges).toHaveBeenCalledWith(rootMap);
    expect(session.status.value.kind).toBe("error");
    expect(session.status.value.message).toContain(
      "voxels partly restored; run undo again",
    );
  });
});

describe("RealignSession drawing", () => {
  const NANOMETRES_PER_UNIT = [16, 16, 45];

  function drawingSession() {
    const space = makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.from(NANOMETRES_PER_UNIT, (nm) => nm * 1e-9),
    });
    const source = new LocalAnnotationSource(
      new WatchableCoordinateSpaceTransform(makeIdentityTransform(space)),
      new WatchableValue(
        parseAnnotationPropertySpecs(REALIGN_ARROW_PROPERTIES),
      ),
      [],
    );
    const graph = {
      branchId: new WatchableValue(BRANCH_ID),
      resolution: NANOMETRES_PER_UNIT,
      graphServer: {
        realignPatchSource: vi.fn(async () => undefined),
        realignCommits: vi.fn(async () => []),
      },
      applyRootChanges: vi.fn(),
    } as unknown as RealignGraph;
    const drawing = {
      layer: {} as UserLayerWithAnnotations,
      annotations: { source } as unknown as AnnotationLayerState,
      coordinates: () =>
        new RealignCoordinates(
          [0, 1, 2].map((annotationAxis) => ({
            annotationAxis,
            scale: 1,
            offset: 0,
          })),
          NANOMETRES_PER_UNIT.map((nm) => nm * 1e-9),
          NANOMETRES_PER_UNIT,
        ),
    };
    return {
      session: new RealignSession(emptyLayers(), graph, drawing),
      source,
    };
  }

  function addCommitted(source: LocalAnnotationSource, annotation: Annotation) {
    const reference = source.add(annotation, /*commit=*/ false);
    source.commit(reference);
    reference.dispose();
  }

  it("reads the box's section and turns an arrow drawn up from the section below", async () => {
    const { session, source } = drawingSession();
    addCommitted(source, {
      id: "box",
      type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
      description: "",
      pointA: Float32Array.of(100, 100, 3104),
      pointB: Float32Array.of(200, 200, 3105),
      properties: [0],
    });
    addCommitted(source, {
      id: "arrow",
      type: AnnotationType.LINE,
      description: "",
      pointA: Float32Array.of(150.5, 150.5, 3103.5),
      pointB: Float32Array.of(152.5, 151.5, 3104.5),
      properties: [0],
    });
    await Promise.resolve();

    const summary = session.summary.value;
    expect(summary.boxSection).toBe(3104);
    expect(summary.lineCount).toBe(1);
    expect(summary.arrows[0].sections).toEqual([3104, 3103]);
  });

  it("stretches the box over the new pair when the reference moves", () => {
    const { session, source } = drawingSession();
    addCommitted(source, {
      id: "box",
      type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
      description: "",
      pointA: Float32Array.of(100, 100, 3103),
      pointB: Float32Array.of(200, 200, 3105),
      properties: [0],
    });
    session.setReferenceOffset(2);

    const box = source.get("box") as AxisAlignedBoundingBox;
    expect([box.pointA[2], box.pointB[2]]).toEqual([3104, 3107]);
    expect(session.summary.value.boxSection).toBe(3104);
    expect(session.summary.value.referenceSection).toBe(3106);
  });
});

describe("RealignSession.clearPreview", () => {
  it("removes the image and the segmentation previews", () => {
    const image = { name: REALIGN_PREVIEW_LAYER };
    const segmentation = { name: REALIGN_SEGMENTATION_PREVIEW_LAYER };
    const removeManagedLayer = vi.fn();
    const layers = {
      rootLayers: { managedLayers: [image, segmentation], removeManagedLayer },
      add: vi.fn(),
    } as unknown as LayerListSpecification;
    const graph = {
      branchId: new WatchableValue(BRANCH_ID),
      resolution: [16, 16, 45],
      graphServer: {
        realignPatchSource: vi.fn(async () => undefined),
        realignCommits: vi.fn(async () => []),
      },
      applyRootChanges: vi.fn(),
    } as unknown as RealignGraph;
    new RealignSession(layers, graph).clearPreview();
    expect(removeManagedLayer).toHaveBeenCalledWith(image);
    expect(removeManagedLayer).toHaveBeenCalledWith(segmentation);
  });
});
