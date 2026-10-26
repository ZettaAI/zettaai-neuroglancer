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
import {
  EMPTY_REALIGN_HISTORY,
  PartialUndoError,
} from "#src/datasource/calcada/realign/realign_commit.js";
import type { RealignGraph } from "#src/datasource/calcada/realign/realign_session.js";
import {
  REALIGN_PREVIEW_LAYER,
  REALIGN_SEGMENTATION_PREVIEW_LAYER,
  RealignSession,
} from "#src/datasource/calcada/realign/realign_session.js";
import { RealignCoordinates } from "#src/datasource/calcada/realign/realign_tools.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { LayerListSpecification } from "#src/layer/index.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { NullarySignal } from "#src/util/signal.js";

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
      realignHistory: vi.fn(async () => EMPTY_REALIGN_HISTORY),
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
        realignHistory: vi.fn(async () => EMPTY_REALIGN_HISTORY),
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
        realignHistory: vi.fn(async () => EMPTY_REALIGN_HISTORY),
      },
      applyRootChanges: vi.fn(),
    } as unknown as RealignGraph;
    new RealignSession(layers, graph).clearPreview();
    expect(removeManagedLayer).toHaveBeenCalledWith(image);
    expect(removeManagedLayer).toHaveBeenCalledWith(segmentation);
  });
});

describe("RealignSession segmentation preview", () => {
  it("hides the segmentation layer only on the previewed section, and shows it again on clear", () => {
    const drawingLayer = {} as UserLayerWithAnnotations;
    const host = {
      name: "segmentation",
      layer: drawingLayer,
      visible: true,
      setVisible: vi.fn(),
    };
    host.setVisible.mockImplementation((visible: boolean) => {
      host.visible = visible;
    });
    const globalPosition = {
      value: Float32Array.of(0, 0, 3104.5),
      changed: new NullarySignal(),
    };
    const managedLayers: { name: string; layer?: unknown }[] = [host];
    const layers = {
      root: {
        globalPosition,
        coordinateSpace: {
          value: { scales: Float64Array.of(16e-9, 16e-9, 45e-9) },
        },
      },
      rootLayers: {
        managedLayers,
        removeManagedLayer: vi.fn((managed) => {
          managedLayers.splice(managedLayers.indexOf(managed), 1);
        }),
      },
      add: vi.fn((managed) => managedLayers.push(managed)),
    } as unknown as LayerListSpecification;
    const graph = {
      branchId: new WatchableValue(BRANCH_ID),
      resolution: [16, 16, 45],
      graphServer: {
        realignHistory: vi.fn(async () => EMPTY_REALIGN_HISTORY),
      },
      applyRootChanges: vi.fn(),
    } as unknown as RealignGraph;
    const session = new RealignSession(layers, graph, {
      layer: drawingLayer,
      annotations: {
        source: new LocalAnnotationSource(
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
          [],
        ),
      } as unknown as AnnotationLayerState,
      coordinates: () => undefined,
    });
    const moveTo = (z: number) => {
      globalPosition.value[2] = z;
      globalPosition.changed.dispatch();
    };

    session["hideSegmentationUnderPreview"](3104);
    expect(host.visible).toBe(false);
    moveTo(3103.5);
    expect(host.visible).toBe(true);
    moveTo(3104.5);
    expect(host.visible).toBe(false);
    session.clearPreview();
    expect(host.visible).toBe(true);
    moveTo(3104.5);
    expect(host.visible).toBe(true);
  });
});

describe("RealignSession history", () => {
  it("lists the realigns a merge into the branch skipped", async () => {
    const skipped = [
      {
        mergeOperationId: 21,
        sourceBranchId: 5,
        operationId: 12,
        region: [10, 4, 1, 30, 24, 2],
        conflictsWith: 20,
      },
    ] as const;
    const graph = {
      branchId: new WatchableValue(BRANCH_ID),
      resolution: [16, 16, 40],
      graphServer: {
        realignHistory: vi.fn(async () => ({ commits: [], skipped })),
      },
      applyRootChanges: vi.fn(),
    } as unknown as RealignGraph;
    const session = new RealignSession(emptyLayers(), graph);
    await vi.waitFor(() => expect(session.skipped.value).toEqual(skipped));
  });
});

describe("RealignSession image source", () => {
  const imageAt = (segment: string, graph = "g") =>
    `middleauth+https://calcada.example/segmentation/table/${graph}/image/${segment}/|neuroglancer-precomputed:`;
  const CALCADA_IMAGE = imageAt("0");
  const revisedImageOf = (branchId: number) =>
    new RegExp(String.raw`/image/${branchId}\.\d+/`);

  function imageLayer(url: string) {
    const dataSource = { spec: { url } };
    const layer = Object.assign(Object.create(ImageUserLayer.prototype), {
      dataSources: [dataSource],
    });
    return { managed: { name: "img", layer }, dataSource };
  }

  function sessionOver(
    managedLayers: { name: string; layer?: unknown }[],
    graphServer: Partial<RealignGraph["graphServer"]> = {},
  ) {
    const layers = {
      rootLayers: {
        managedLayers,
        removeManagedLayer: vi.fn((managed) => {
          managedLayers.splice(managedLayers.indexOf(managed), 1);
        }),
      },
      add: vi.fn(),
    } as unknown as LayerListSpecification;
    const branchId = new WatchableValue(BRANCH_ID);
    const graph = {
      branchId,
      graphUrl: "https://calcada.example/segmentation/api/v1/table/g",
      resolution: [16, 16, 40],
      graphServer: {
        realignHistory: vi.fn(async () => EMPTY_REALIGN_HISTORY),
        undoRealign: vi.fn(async () => new Map()),
        ...graphServer,
      },
      applyRootChanges: vi.fn(),
    } as unknown as RealignGraph;
    return { session: new RealignSession(layers, graph), branchId };
  }

  it("points the calcada image layer at the session's branch", () => {
    const { managed, dataSource } = imageLayer(CALCADA_IMAGE);
    sessionOver([managed]);
    expect(dataSource.spec.url).toBe(imageAt(String(BRANCH_ID)));
  });

  it("follows a branch switch with a fresh revision", () => {
    const { managed, dataSource } = imageLayer(CALCADA_IMAGE);
    const { branchId } = sessionOver([managed]);
    branchId.value = 5;
    expect(dataSource.spec.url).toMatch(revisedImageOf(5));
  });

  it("reads the image again after an undo", async () => {
    const { managed, dataSource } = imageLayer(CALCADA_IMAGE);
    const { session } = sessionOver([managed]);
    await session.undo(12);
    expect(dataSource.spec.url).toMatch(revisedImageOf(BRANCH_ID));
  });

  it("reads the image again after a commit", async () => {
    const { managed, dataSource } = imageLayer(CALCADA_IMAGE);
    const { session } = sessionOver([managed], {
      commitRealign: vi.fn(async () => ({
        operationId: 12,
        sections: 1,
        touchedPieces: 0,
      })),
      realignCommitStatus: vi.fn(async () => ({
        status: "done" as const,
        rootMap: new Map(),
      })),
    });
    session["applied"] = {
      selectionKey: "",
      selection: {
        box: { x0: 0, y0: 0, x1: 8, y1: 8, z: 4 },
        referenceSection: 3,
        lines: [],
        rejected: [],
      },
      field: { data: new Float32Array(2), shape: [2, 1, 1, 1] },
    };
    await session.commit(5);
    expect(session.status.value.kind).toBe("done");
    expect(dataSource.spec.url).toMatch(revisedImageOf(BRANCH_ID));
  });

  it.each([
    ["refused", new Error("realign is not the latest")],
    ["partial", new PartialUndoError("voxels partly restored", new Map())],
  ])("reads the image again after a %s undo", async (_outcome, refusal) => {
    const { managed, dataSource } = imageLayer(CALCADA_IMAGE);
    const { session } = sessionOver([managed], {
      undoRealign: vi.fn(async () => {
        throw refusal;
      }),
    });
    await session.undo(12);
    expect(session.status.value.kind).toBe("error");
    expect(dataSource.spec.url).toMatch(revisedImageOf(BRANCH_ID));
  });

  it("gives each bump a new URL across sessions over one graph", async () => {
    const { managed, dataSource } = imageLayer(CALCADA_IMAGE);
    const { session: first } = sessionOver([managed]);
    const { session: second } = sessionOver([managed]);
    await first.undo(12);
    const afterFirst = dataSource.spec.url;
    await second.undo(12);
    expect(dataSource.spec.url).not.toBe(afterFirst);
  });

  it("leaves an image layer that reads the bucket alone", () => {
    const bucket = "gs://bucket/img/|neuroglancer-precomputed:";
    const { managed, dataSource } = imageLayer(bucket);
    sessionOver([managed]);
    expect(dataSource.spec.url).toBe(bucket);
  });

  it("leaves another graph's image layer alone", () => {
    const otherGraph = imageAt("0", "other");
    const { managed, dataSource } = imageLayer(otherGraph);
    sessionOver([managed]);
    expect(dataSource.spec.url).toBe(otherGraph);
  });

  it("removes the patch layers an older state carries", () => {
    const managedLayers = [
      { name: "realign patch" },
      { name: "realign patch (main)" },
      { name: "img" },
    ];
    sessionOver(managedLayers);
    expect(managedLayers.map((managed) => managed.name)).toEqual(["img"]);
  });
});
