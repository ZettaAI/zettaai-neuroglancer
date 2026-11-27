import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphImage } from "#src/datasource/calcada/graph_image_layer.js";
import { addGraphImageLayer } from "#src/datasource/calcada/graph_image_layer.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { LayerListSpecification, UserLayer } from "#src/layer/index.js";
import * as layerModule from "#src/layer/index.js";
import { WatchableValue } from "#src/trackable_value.js";

const SEGMENTATION_URL =
  "middleauth+https://calcada.example/segmentation/api/v1/table/g";
const GRAPH_URL = "https://calcada.example/segmentation/api/v1/table/g";

function imageLayer(url: string) {
  return {
    name: "img",
    layer: Object.assign(Object.create(ImageUserLayer.prototype), {
      dataSources: [{ spec: { url } }],
    }),
  };
}

function setup(managedLayers: { name: string; layer: unknown }[] = []) {
  const host = {} as UserLayer;
  managedLayers.push({ name: "calcada", layer: host });
  const layers = {
    rootLayers: { managedLayers },
    add: vi.fn(),
  } as unknown as LayerListSpecification;
  vi.spyOn(layerModule, "makeLayer").mockImplementation(
    (_manager, name, spec) => ({ name, spec }) as never,
  );
  return { host, layers };
}

function graphImage(hasImage: GraphImage["hasImage"]): GraphImage {
  return {
    table: "g",
    segmentationUrl: SEGMENTATION_URL,
    graphUrl: GRAPH_URL,
    branchId: new WatchableValue(4),
    hasImage: vi.fn(hasImage),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("addGraphImageLayer", () => {
  it("adds the image under the calcada layer, on the current branch", async () => {
    const { host, layers } = setup([imageLayer("gs://bucket/img")]);
    await addGraphImageLayer(
      layers,
      host,
      graphImage(async () => true),
      () => false,
    );
    expect(layers.add).toHaveBeenCalledWith(
      {
        name: "g image",
        spec: {
          type: "image",
          source: `${SEGMENTATION_URL}/image/4/|neuroglancer-precomputed:`,
        },
      },
      1,
    );
  });

  it("leaves a state that already reads the image through calcada alone", async () => {
    const { host, layers } = setup([
      imageLayer(
        "middleauth+https://calcada.example/segmentation/table/g/image/0/|neuroglancer-precomputed:",
      ),
    ]);
    const image = graphImage(async () => true);
    await addGraphImageLayer(layers, host, image, () => false);
    expect(image.hasImage).not.toHaveBeenCalled();
    expect(layers.add).not.toHaveBeenCalled();
  });

  it("adds nothing for a graph without an image", async () => {
    const { host, layers } = setup();
    await addGraphImageLayer(
      layers,
      host,
      graphImage(async () => false),
      () => false,
    );
    expect(layers.add).not.toHaveBeenCalled();
  });

  it("asks again while calcada cannot tell yet", async () => {
    vi.useFakeTimers();
    const { host, layers } = setup();
    let calls = 0;
    const image = graphImage(async () => {
      calls++;
      if (calls === 1) throw new Error("401");
      return true;
    });
    const adding = addGraphImageLayer(layers, host, image, () => false);
    await vi.runAllTimersAsync();
    await adding;
    expect(image.hasImage).toHaveBeenCalledTimes(2);
    expect(layers.add).toHaveBeenCalledTimes(1);
  });

  it("adds nothing once the calcada layer is gone", async () => {
    const { host, layers } = setup();
    await addGraphImageLayer(
      layers,
      host,
      graphImage(async () => true),
      () => true,
    );
    expect(layers.add).not.toHaveBeenCalled();
  });
});
