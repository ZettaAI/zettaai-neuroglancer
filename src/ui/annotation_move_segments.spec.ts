import { describe, expect, it } from "vitest";
import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import { AnnotationSource, AnnotationType } from "#src/annotation/index.js";
import { showSegmentsOnMoveToAnnotation } from "#src/ui/annotations.js";

const ANNOTATION_ID = "picked";
const RANK = 3;

function annotationLayer() {
  const source = new AnnotationSource(RANK);
  source
    .add({
      id: ANNOTATION_ID,
      type: AnnotationType.POINT,
      point: Float32Array.of(1, 2, 3),
      relatedSegments: [],
      properties: [],
    })
    .dispose();
  const state = {
    source,
    displayState: { swapVisibleSegmentsOnMove: { value: true } },
  } as unknown as AnnotationLayerState;
  return { source, state };
}

describe("showSegmentsOnMoveToAnnotation", () => {
  it("lets go of the annotation's reference once, however often it changes later", () => {
    const { source, state } = annotationLayer();
    const selectionPanelReference = source.getReference(ANNOTATION_ID);
    showSegmentsOnMoveToAnnotation(state, ANNOTATION_ID);
    selectionPanelReference.changed.dispatch();
    selectionPanelReference.changed.dispatch();
    expect(selectionPanelReference.refCount).toBe(1);
    expect(source.references.get(ANNOTATION_ID)).toBe(selectionPanelReference);
    selectionPanelReference.dispose();
  });
});
