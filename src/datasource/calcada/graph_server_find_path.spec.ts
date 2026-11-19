import { describe, expect, it } from "vitest";
import type { SegmentSelection } from "#src/datasource/calcada/frontend.js";
import { CalcadaGraphServerInterface } from "#src/datasource/calcada/frontend.js";
import type { FetchOk } from "#src/util/http_request.js";

const BRANCH_ID = 16;

function selection(rootId: bigint): SegmentSelection {
  return { segmentId: rootId, rootId, position: Float32Array.of(1, 2, 3) };
}

function recordingServer() {
  const urls: string[] = [];
  const fetchOkImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ centroids_list: [[1, 2, 3]] }));
  }) as unknown as FetchOk;
  const server = new CalcadaGraphServerInterface({
    fetchOkImpl,
    baseUrl: "https://calcada.test/segmentation/api/v1/table/graph",
  });
  return { server, urls };
}

describe("CalcadaGraphServerInterface.findPath", () => {
  it("asks on the branch the layer is on", async () => {
    const { server, urls } = recordingServer();
    await server.findPath(selection(1n), selection(2n), false, BRANCH_ID);
    expect(new URL(urls[0]).searchParams.get("branch_id")).toBe(
      String(BRANCH_ID),
    );
  });

  it("leaves the branch out on main", async () => {
    const { server, urls } = recordingServer();
    await server.findPath(selection(1n), selection(2n), false, 0);
    expect(new URL(urls[0]).searchParams.has("branch_id")).toBe(false);
  });
});
