// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildApplyCorrespondencesForm,
  parseApplyCorrespondencesResponse,
  warpedImageToUint8,
} from "#src/datasource/calcada/realign/apply_correspondences_request.js";

function binaryResponse(header: object, blocks: Float32Array[]): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const total =
    4 +
    headerBytes.length +
    blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const buffer = new ArrayBuffer(total);
  new DataView(buffer).setUint32(0, headerBytes.length, true);
  new Uint8Array(buffer, 4, headerBytes.length).set(headerBytes);
  let offset = 4 + headerBytes.length;
  for (const block of blocks) {
    new Uint8Array(buffer, offset, block.byteLength).set(
      new Uint8Array(block.buffer),
    );
    offset += block.byteLength;
  }
  return buffer;
}

async function gunzip(blob: Blob): Promise<ArrayBuffer> {
  return new Response(
    blob.stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
}

describe("buildApplyCorrespondencesForm", () => {
  it("sends a manual-only, zero-boundary request with a gzipped normalised crop", async () => {
    const form = await buildApplyCorrespondencesForm(
      new Uint8Array([0, 255, 51, 102]),
      2,
      2,
      [{ id: "a", start: [1, 1], end: [0, 0] }],
    );
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata).toMatchObject({
      src_encoding_shape: [1, 2, 2, 1],
      mse_weight: 0,
      rig: 10,
      lr: 0.03,
      num_iter: 50,
      optimizer_type: "adam",
      run_misd: false,
      run_warp: true,
      zero_boundary: true,
      correspondences: { lines: [{ id: "a", start: [1, 1], end: [0, 0] }] },
    });
    const encoding = new Float32Array(
      await gunzip(form.get("src-encoding-data") as Blob),
    );
    expect(encoding).toEqual(Float32Array.from([0, 1, 0.2, 0.4]));
  });

  it("sends the crop once, as the encoding", async () => {
    const form = await buildApplyCorrespondencesForm(
      new Uint8Array(4),
      2,
      2,
      [],
    );
    expect(form.has("src-image-data")).toBe(false);
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata).not.toHaveProperty("src_image_shape");
  });
});

describe("parseApplyCorrespondencesResponse", () => {
  it("reads the field and the warped image", async () => {
    const field = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const warped = new Float32Array([0, 0.5, 1, 0.25]);
    const result = await parseApplyCorrespondencesResponse(
      binaryResponse(
        { relaxed_field_shape: [2, 2, 2, 1], warped_image_shape: [1, 2, 2, 1] },
        [field, warped],
      ),
    );
    expect(Array.from(result.field.data)).toEqual(Array.from(field));
    expect(result.warpedImage?.shape).toEqual([1, 2, 2, 1]);
  });

  it("gunzips a compressed body", async () => {
    const plain = binaryResponse({ relaxed_field_shape: [2, 1, 1, 1] }, [
      new Float32Array([1, 2]),
    ]);
    const gzipped = await new Response(
      new Blob([plain]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    const result = await parseApplyCorrespondencesResponse(gzipped);
    expect(Array.from(result.field.data)).toEqual([1, 2]);
  });

  it("fails without a field", async () => {
    await expect(
      parseApplyCorrespondencesResponse(binaryResponse({}, [])),
    ).rejects.toThrow(/field/);
  });
});

describe("warpedImageToUint8", () => {
  it("scales and clamps to bytes", () => {
    expect(
      Array.from(
        warpedImageToUint8({
          data: new Float32Array([0, 0.5, 1, 1.4, -0.2]),
          shape: [1, 5, 1, 1],
        }),
      ),
    ).toEqual([0, 128, 255, 255, 0]);
  });
});
