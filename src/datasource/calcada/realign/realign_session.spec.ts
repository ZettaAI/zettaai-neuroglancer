import { describe, expect, it, vi } from "vitest";
import { PartialUndoError } from "#src/datasource/calcada/realign/realign_commit.js";
import type { RealignGraph } from "#src/datasource/calcada/realign/realign_session.js";
import { RealignSession } from "#src/datasource/calcada/realign/realign_session.js";
import type { LayerListSpecification } from "#src/layer/index.js";
import { WatchableValue } from "#src/trackable_value.js";

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
