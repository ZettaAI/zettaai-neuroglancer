/**
 * The first shown layer over `layer`'s graph, or `layer` itself when they are
 * all hidden or its graph is not known yet.
 */
export function firstShownOverGraph<Layer>(
  layer: Layer,
  managed: Iterable<{ visible: boolean; layer: Layer }>,
  graphUrlOf: (layer: Layer) => string | undefined,
): Layer {
  const url = graphUrlOf(layer);
  if (url === undefined) return layer;
  for (const { visible, layer: other } of managed) {
    if (visible && graphUrlOf(other) === url) return other;
  }
  return layer;
}
