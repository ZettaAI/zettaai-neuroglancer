import { describe, expect, it } from "vitest";
import type { UserLayerSelectionState } from "#src/layer/index.js";
import { UserLayer } from "#src/layer/index.js";

const SUBSUBSOURCE = "merge_candidates";

const layer = {
  localCoordinateSpace: { value: { rank: 0 } },
} as unknown as UserLayer;

function selectionState(): UserLayerSelectionState {
  const state = {} as UserLayerSelectionState;
  UserLayer.prototype.initializeSelectionState.call(layer, state);
  return state;
}

function selectedAnnotation(): UserLayerSelectionState {
  const state = selectionState();
  state.annotationId = `${SUBSUBSOURCE}:1`;
  state.annotationSourceIndex = 0;
  state.annotationSubsource = "default";
  state.annotationSubsubsourceId = SUBSUBSOURCE;
  return state;
}

describe("annotation selection state", () => {
  it("a copy keeps the annotation's subsubsource", () => {
    const copy = selectionState();
    UserLayer.prototype.copySelectionState.call(
      layer,
      copy,
      selectedAnnotation(),
    );
    expect(copy.annotationSubsubsourceId).toBe(SUBSUBSOURCE);
  });

  it("JSON keeps the annotation's subsubsource", () => {
    const json = UserLayer.prototype.selectionStateToJson.call(
      layer,
      selectedAnnotation(),
      false,
    );
    const restored = selectionState();
    UserLayer.prototype.selectionStateFromJson.call(layer, restored, json);
    expect(restored.annotationSubsubsourceId).toBe(SUBSUBSOURCE);
  });
});
