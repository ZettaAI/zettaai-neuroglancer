import { describe, expect, it } from "vitest";
import { sameFilter } from "#src/datasource/calcada/candidate_filter_text.js";
import { minCandidateVoxels } from "#src/datasource/calcada/candidate_filter_tree.js";
import type { ScoreRange } from "#src/datasource/calcada/trace_state.js";
import {
  stepScoreRangeLow,
  TRACE_SPHERE_RADIUS_DEFAULT_NM,
  withinScoreRange,
  ZettaTraceState,
} from "#src/datasource/calcada/trace_state.js";

describe("ZettaTraceState", () => {
  it("starts off with no aiming and the default radius", () => {
    const state = new ZettaTraceState();
    expect(state.active.value).toBe(false);
    expect(state.aiming.value).toBe(false);
    expect(state.sphereRadiusNm.value).toBe(TRACE_SPHERE_RADIUS_DEFAULT_NM);
    expect(state.sphereCenter.value).toBeUndefined();
    state.dispose();
  });

  it("keeps the trace alive while aiming over it", () => {
    const state = new ZettaTraceState();
    state.active.value = true;
    state.aiming.value = true;
    expect(state.active.value).toBe(true);
    state.aiming.value = false;
    expect(state.active.value).toBe(true);
    state.dispose();
  });

  it("does not serialize the aiming phase", () => {
    const state = new ZettaTraceState();
    state.aiming.value = true;
    expect(JSON.stringify(state.toJSON())).not.toContain("aiming");
    state.dispose();
  });

  it("round-trips the sphere through JSON", () => {
    const state = new ZettaTraceState();
    state.active.value = true;
    state.sphereRadiusNm.value = 1234;
    state.sphereCenter.value = Float32Array.of(10, 20, 30);

    const restored = new ZettaTraceState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.sphereRadiusNm.value).toBe(1234);
    expect(Array.from(restored.sphereCenter.value!)).toEqual([10, 20, 30]);
    state.dispose();
    restored.dispose();
  });

  it("keeps the radius but drops the placed sphere on reset", () => {
    const state = new ZettaTraceState();
    state.sphereRadiusNm.value = 999;
    state.sphereCenter.value = Float32Array.of(1, 2, 3);
    state.aiming.value = true;
    state.reset();
    expect(state.sphereCenter.value).toBeUndefined();
    expect(state.aiming.value).toBe(false);
    expect(state.sphereRadiusNm.value).toBe(999);
    state.dispose();
  });

  it("cancels only the aim when escaping over a live trace", () => {
    const state = new ZettaTraceState();
    state.active.value = true;
    state.aiming.value = true;
    state.cancelInnermost();
    expect(state.aiming.value).toBe(false);
    expect(state.active.value).toBe(true);
    state.dispose();
  });

  it("ends the trace when escaping with the sights down", () => {
    const state = new ZettaTraceState();
    state.active.value = true;
    state.cancelInnermost();
    expect(state.active.value).toBe(false);
    state.dispose();
  });

  it("defaults to the sphere scope and round-trips the other", () => {
    const state = new ZettaTraceState();
    expect(state.scope.value).toBe("sphere");
    state.scope.value = "segment";

    const restored = new ZettaTraceState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.scope.value).toBe("segment");
    state.dispose();
    restored.dispose();
  });

  it("refuses a scope it does not know", () => {
    const state = new ZettaTraceState();
    state.restoreState({ scope: "everything" });
    expect(state.scope.value).toBe("sphere");
    state.dispose();
  });
});

describe("ZettaTraceState filter", () => {
  it("rebuilds an old link's fixed filters as a tree and never writes them back", () => {
    const state = new ZettaTraceState();
    state.restoreState({
      minScore: 0.5,
      minPieceVoxels: 2000,
      targetClass: "axon",
    });
    expect(state.filter.value.children).toHaveLength(3);
    expect(state.minPieceVoxels.value).toBe(2000);
    const json = state.toJSON() as Record<string, unknown>;
    expect(json.minScore).toBeUndefined();
    expect(json.minPieceVoxels).toBeUndefined();
    expect(json.targetClass).toBeUndefined();
    expect(json.filter).toBeDefined();
  });

  it("round-trips the tree and the preset id", () => {
    const state = new ZettaTraceState();
    state.restoreState({ minScore: 0.4 });
    state.filterPresetId.value = "17";
    const restored = new ZettaTraceState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(sameFilter(restored.filter.value, state.filter.value)).toBe(true);
    expect(restored.filterPresetId.value).toBe("17");
  });

  it("derives the server's size floor from the tree", () => {
    const state = new ZettaTraceState();
    state.filter.value = {
      kind: "group",
      op: "any",
      children: [
        {
          kind: "cond",
          field: "size",
          op: ">=",
          value: 500,
          target: "candidate",
        },
        {
          kind: "cond",
          field: "size",
          op: ">=",
          value: 300,
          target: "candidate",
        },
      ],
    };
    expect(state.minPieceVoxels.value).toBe(
      minCandidateVoxels(state.filter.value),
    );
    expect(state.minPieceVoxels.value).toBe(300);
  });

  it("migrates a v1 linked filter and writes it back as v2", () => {
    const state = new ZettaTraceState();
    state.restoreState({
      filter: {
        v: 1,
        root: {
          kind: "group",
          op: "and",
          children: [
            {
              kind: "condition",
              field: { side: "candidate", measure: "share", class: "axon" },
              cmp: ">=",
              value: 0.8,
            },
          ],
        },
      },
    });
    expect(state.filter.value).toMatchObject({
      kind: "group",
      op: "all",
      children: [
        {
          kind: "cond",
          field: "axon",
          op: ">=",
          value: 80,
          target: "candidate",
        },
      ],
    });
    const json = state.toJSON() as { filter: { v: number } };
    expect(json.filter.v).toBe(2);
  });

  it("ignores a malformed linked filter", () => {
    const state = new ZettaTraceState();
    state.restoreState({ filter: { v: 2, root: { kind: "nope" } } });
    expect(state.filter.value.children).toEqual([]);
  });
});

describe("ZettaTraceState filter editor", () => {
  it("is closed by default and round-trips where it is and whether it is open", () => {
    const state = new ZettaTraceState();
    expect(state.filterEditor.visible).toBe(false);
    expect((state.toJSON() as Record<string, unknown>).filterEditor).toBe(
      undefined,
    );
    state.filterEditor.value = {
      ...state.filterEditor.value,
      visible: true,
      size: 480,
    };
    const restored = new ZettaTraceState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.filterEditor.visible).toBe(true);
    expect(restored.filterEditor.value.size).toBe(480);
  });
});

describe("ZettaTraceState score range", () => {
  it("lets every score through by default and round-trips a narrowed range", () => {
    const state = new ZettaTraceState();
    expect(state.scoreRange.value).toEqual([0, 1]);
    expect((state.toJSON() as Record<string, unknown>).scoreRange).toBe(
      undefined,
    );
    state.scoreRange.value = [0.3, 0.85];
    const restored = new ZettaTraceState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.scoreRange.value).toEqual([0.3, 0.85]);
  });

  it("is one of the filters that hide queued candidates", () => {
    const state = new ZettaTraceState();
    expect(state.candidateFilterSignals).toContain(state.scoreRange);
  });

  it("keeps a restored range inside 0–1 and in order", () => {
    const state = new ZettaTraceState();
    state.restoreState({ scoreRange: [0.9, 0.2] });
    expect(state.scoreRange.value).toEqual([0.2, 0.9]);
    state.restoreState({ scoreRange: [-1, 3] });
    expect(state.scoreRange.value).toEqual([0, 1]);
  });
});

describe("withinScoreRange", () => {
  it("includes both ends", () => {
    expect(withinScoreRange(0.3, [0.3, 0.85])).toBe(true);
    expect(withinScoreRange(0.85, [0.3, 0.85])).toBe(true);
    expect(withinScoreRange(0.29, [0.3, 0.85])).toBe(false);
    expect(withinScoreRange(0.9, [0.3, 0.85])).toBe(false);
  });
});

describe("stepScoreRangeLow", () => {
  it("moves the lowest score by 0.05 and keeps the highest", () => {
    expect(stepScoreRangeLow([0.3, 0.9], 1)).toEqual([0.35, 0.9]);
    expect(stepScoreRangeLow([0.3, 0.9], -1)).toEqual([0.25, 0.9]);
  });

  it("lands on round steps rather than drifting", () => {
    let range: ScoreRange = [0, 1];
    for (let i = 0; i < 7; i++) range = stepScoreRangeLow(range, 1);
    expect(range[0]).toBe(0.35);
  });

  it("stops at zero and at the highest score", () => {
    expect(stepScoreRangeLow([0, 1], -1)).toEqual([0, 1]);
    expect(stepScoreRangeLow([0.78, 0.8], 1)).toEqual([0.8, 0.8]);
  });
});

describe("ZettaTraceState.stepPlusMinus", () => {
  it("steps the lowest score", () => {
    const state = new ZettaTraceState();
    state.stepPlusMinus(1);
    expect(state.scoreRange.value).toEqual([0.05, 1]);
  });

  it("resizes the sphere instead while aiming", () => {
    const state = new ZettaTraceState();
    state.aiming.value = true;
    state.stepPlusMinus(1);
    expect(state.scoreRange.value).toEqual([0, 1]);
    expect(state.sphereRadiusNm.value).toBeGreaterThan(
      TRACE_SPHERE_RADIUS_DEFAULT_NM,
    );
  });
});

describe("ZettaTraceState keepSplitParts", () => {
  it("is off by default and kept in the link when on", () => {
    const state = new ZettaTraceState();
    expect(state.keepSplitParts.value).toBe(false);
    state.keepSplitParts.value = true;
    const restored = new ZettaTraceState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.keepSplitParts.value).toBe(true);
  });
});
