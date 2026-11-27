// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildAutomaticCorrespondencesForm,
  CROP_EDGE_MARGIN_PX,
  parseAutomaticCorrespondences,
} from "#src/datasource/calcada/realign/automatic_correspondences_request.js";

const SIZE = 100;
const crop = { data: new Uint8Array(SIZE * SIZE), width: SIZE, height: SIZE };

describe("buildAutomaticCorrespondencesForm", () => {
  it("sends both crops as uint8 [H, W] and the existing lines", async () => {
    const reference = { ...crop, data: new Uint8Array(SIZE * SIZE).fill(7) };
    const form = buildAutomaticCorrespondencesForm(crop, reference, [
      { id: "a", start: [10, 20], end: [11, 22] },
    ]);
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata).toMatchObject({
      src_image_shape: [SIZE, SIZE],
      tgt_image_shape: [SIZE, SIZE],
      existing_correspondences: [{ start: [10, 20], end: [11, 22] }],
    });
    const target = new Uint8Array(
      await (form.get("tgt-image-data") as Blob).arrayBuffer(),
    );
    expect(target.length).toBe(SIZE * SIZE);
    expect(target[0]).toBe(7);
  });

  it("leaves the existing lines out when there are none", async () => {
    const form = buildAutomaticCorrespondencesForm(crop, crop, []);
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata).not.toHaveProperty("existing_correspondences");
  });
});

describe("parseAutomaticCorrespondences", () => {
  it("keeps matches inside the margin and drops those by the crop's edge", () => {
    const inside = { start: [50, 40], end: [52, 45], id: "1" };
    const byTheEdge = {
      start: [50, 40],
      end: [50, SIZE - CROP_EDGE_MARGIN_PX + 1],
      id: "2",
    };
    const nearTheOrigin = {
      start: [CROP_EDGE_MARGIN_PX - 1, 40],
      end: [50, 50],
      id: "3",
    };
    expect(
      parseAutomaticCorrespondences(
        {
          lines: [inside, byTheEdge, nearTheOrigin],
          num_inliers: 0,
          num_matches: 3,
        },
        crop,
      ),
    ).toEqual([{ start: [50, 40], end: [52, 45] }]);
  });
});
