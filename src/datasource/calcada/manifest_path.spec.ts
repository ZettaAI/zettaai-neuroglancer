import { describe, expect, it } from "vitest";
import { buildManifestPath } from "#src/datasource/calcada/manifest_path.js";

describe("buildManifestPath", () => {
  it("builds the mainline path without branch_id", () => {
    expect(buildManifestPath(123n, 0, 0)).toBe(
      "/manifest/123:0?verify=1&prepend_seg_ids=1",
    );
  });
  it("appends branch_id for branches", () => {
    expect(buildManifestPath(123n, 0, 7)).toBe(
      "/manifest/123:0?verify=1&prepend_seg_ids=1&branch_id=7",
    );
  });
});
