import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type { AnnotationId } from "#src/annotation/index.js";
import type { MouseSelectionState } from "#src/layer/index.js";

/**
 * Over an annotation the mouse position is already snapped to it, so moving
 * there is moving to the annotation; it is pinned first, while the mouse
 * still picks it.
 */
export function moveToMousePosition(
  mouseState: Pick<
    MouseSelectionState,
    | "position"
    | "pickedAnnotationLayer"
    | "pickedAnnotationId"
    | "updateUnconditionally"
  >,
  navigationPosition: { value: Float32Array },
  selection: { select(): void },
  showAnnotationSegments: (
    annotationLayer: AnnotationLayerState,
    id: AnnotationId,
  ) => void,
) {
  if (!mouseState.updateUnconditionally()) return;
  const { pickedAnnotationLayer, pickedAnnotationId } = mouseState;
  if (pickedAnnotationLayer !== undefined && pickedAnnotationId !== undefined) {
    selection.select();
    showAnnotationSegments(pickedAnnotationLayer, pickedAnnotationId);
  }
  navigationPosition.value = mouseState.position;
}
