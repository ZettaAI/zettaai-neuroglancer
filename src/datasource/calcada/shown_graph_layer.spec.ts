import { describe, expect, it } from "vitest";
import { firstShownOverGraph } from "#src/datasource/calcada/shown_graph_layer.js";

const GRAPH = "calcada://graph";
const OTHER_GRAPH = "calcada://other";

interface FakeLayer {
  name: string;
  url: string | undefined;
}

const urlOf = (layer: FakeLayer) => layer.url;

describe("firstShownOverGraph", () => {
  const main = { name: "main", url: GRAPH };
  const branch = { name: "branch", url: GRAPH };

  it("picks the first shown layer over the same graph", () => {
    const managed = [
      { visible: false, layer: main },
      { visible: true, layer: branch },
    ];
    expect(firstShownOverGraph(main, managed, urlOf)).toBe(branch);
    expect(firstShownOverGraph(branch, managed, urlOf)).toBe(branch);
  });

  it("leaves a layer over another graph to itself", () => {
    const other = { name: "other", url: OTHER_GRAPH };
    const managed = [
      { visible: true, layer: main },
      { visible: true, layer: other },
    ];
    expect(firstShownOverGraph(other, managed, urlOf)).toBe(other);
  });

  it("falls back to the layer itself when every layer is hidden", () => {
    const managed = [
      { visible: false, layer: main },
      { visible: false, layer: branch },
    ];
    expect(firstShownOverGraph(branch, managed, urlOf)).toBe(branch);
  });

  it("falls back to the layer itself before its graph is known", () => {
    const loading = { name: "loading", url: undefined };
    const managed = [
      { visible: true, layer: main },
      { visible: true, layer: loading },
    ];
    expect(firstShownOverGraph(loading, managed, urlOf)).toBe(loading);
  });
});
