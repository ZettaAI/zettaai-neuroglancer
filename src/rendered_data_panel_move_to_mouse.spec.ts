import { describe, expect, it } from "vitest";
import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import { moveToMousePosition } from "#src/rendered_data_panel_move_to_mouse.js";

const MOUSE_POSITION = Float32Array.of(10, 20, 30);
const ANNOTATION_ID = "merge_candidates:1";
const ANNOTATION_LAYER = {} as AnnotationLayerState;

function rightClick(pickedAnnotationId: string | undefined) {
  const mouseState = {
    position: MOUSE_POSITION,
    pickedAnnotationLayer:
      pickedAnnotationId === undefined ? undefined : ANNOTATION_LAYER,
    pickedAnnotationId,
    updateUnconditionally: () => true,
  };
  const navigation = { value: Float32Array.of(0, 0, 0) };
  const order: string[] = [];
  const selection = {
    pinned: false,
    select() {
      this.pinned = true;
      order.push(`select at ${navigation.value.join(",")}`);
    },
  };
  const shownSegmentsOf: [AnnotationLayerState, string][] = [];
  moveToMousePosition(mouseState, navigation, selection, (layer, id) =>
    shownSegmentsOf.push([layer, id]),
  );
  return { navigation, selection, order, shownSegmentsOf };
}

describe("moveToMousePosition", () => {
  it("on an annotation pins it before moving to it", () => {
    const { navigation, selection, order } = rightClick(ANNOTATION_ID);
    expect(selection.pinned).toBe(true);
    expect(order).toEqual(["select at 0,0,0"]);
    expect(navigation.value).toEqual(MOUSE_POSITION);
  });

  it("on an annotation shows its segments", () => {
    const { shownSegmentsOf } = rightClick(ANNOTATION_ID);
    expect(shownSegmentsOf).toEqual([[ANNOTATION_LAYER, ANNOTATION_ID]]);
  });

  it("elsewhere only moves, leaving the selection and segments alone", () => {
    const { navigation, selection, shownSegmentsOf } = rightClick(undefined);
    expect(selection.pinned).toBe(false);
    expect(shownSegmentsOf).toEqual([]);
    expect(navigation.value).toEqual(MOUSE_POSITION);
  });
});
