/**
 * @file Wire format of web_api's `POST /alignment/apply_correspondences` for a
 * manual-only, zero-boundary relaxation, mirroring the portal's client.
 * Tensors are `[C, H, W, 1]` float32 with H the crop's rows (y).
 */

import type { CorrespondenceLine } from "#src/datasource/calcada/realign/realign_selection.js";

export const APPLY_CORRESPONDENCES_PATH = "/alignment/apply_correspondences";

const UINT8_MAX = 255;
const GZIP_MAGIC = [0x1f, 0x8b];
const HEADER_LENGTH_BYTES = 4;

const RESPONSE_TENSORS = [
  { key: "field", shapeKey: "relaxed_field_shape" },
  { key: "warpedImage", shapeKey: "warped_image_shape" },
  { key: "misdImage", shapeKey: "misd_image_shape" },
  { key: "warpedEncoding", shapeKey: "warped_encoding_shape" },
] as const;

export interface FloatTensor {
  readonly data: Float32Array;
  readonly shape: number[];
}

/**
 * The portal's correspondence-tool defaults (voxel-editor initial state):
 * without them web_api falls back to rig 1000, lr 0.001 and 200 iterations,
 * which warp differently from what users know from the portal.
 */
const PORTAL_OPTIMIZATION = {
  rig: 10,
  lr: 0.03,
  num_iter: 50,
  optimizer_type: "adam",
};

export interface ApplyCorrespondencesResult {
  readonly field: FloatTensor;
  readonly warpedImage?: FloatTensor;
}

/** With a reference crop, image similarity weighs in as in the portal. */
const REFERENCE_MSE_WEIGHT = 1;

/**
 * The crop goes once, as the encoding: without a separate display image,
 * web_api returns the warped encoding as `warped_image`. The reference
 * section's crop, when given, is the target encoding the MSE term matches it
 * to. Both are gzipped because Cloud Run caps a request at 32 MiB, which raw
 * float32 crosses near 2900².
 */
export async function buildApplyCorrespondencesForm(
  crop: Uint8Array,
  width: number,
  height: number,
  lines: readonly CorrespondenceLine[],
  referenceCrop?: Uint8Array,
): Promise<FormData> {
  const shape = [1, height, width, 1];
  const metadata = {
    correspondences: { lines },
    src_encoding_shape: shape,
    ...(referenceCrop === undefined
      ? { mse_weight: 0 }
      : { tgt_encoding_shape: shape, mse_weight: REFERENCE_MSE_WEIGHT }),
    ...PORTAL_OPTIMIZATION,
    run_misd: false,
    run_warp: true,
    zero_boundary: true,
  };
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  form.append("src-encoding-data", await encodingBlob(crop), "src");
  if (referenceCrop !== undefined) {
    form.append("tgt-encoding-data", await encodingBlob(referenceCrop), "tgt");
  }
  return form;
}

async function encodingBlob(crop: Uint8Array): Promise<Blob> {
  const normalised = Float32Array.from(crop, (value) => value / UINT8_MAX);
  return new Blob([await gzip(normalised.buffer)], {
    type: "application/octet-stream",
  });
}

async function gzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(
    new Response(buffer).body!.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
}

async function gunzipIfCompressed(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(
    buffer,
    0,
    Math.min(GZIP_MAGIC.length, buffer.byteLength),
  );
  if (head[0] !== GZIP_MAGIC[0] || head[1] !== GZIP_MAGIC[1]) return buffer;
  return new Response(
    new Response(buffer).body!.pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
}

export async function parseApplyCorrespondencesResponse(
  body: ArrayBuffer,
): Promise<ApplyCorrespondencesResult> {
  const buffer = await gunzipIfCompressed(body);
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(buffer, HEADER_LENGTH_BYTES, headerLength),
    ),
  ) as Record<string, number[] | undefined>;
  const tensors: Partial<
    Record<(typeof RESPONSE_TENSORS)[number]["key"], FloatTensor>
  > = {};
  let offset = HEADER_LENGTH_BYTES + headerLength;
  for (const { key, shapeKey } of RESPONSE_TENSORS) {
    const shape = header[shapeKey];
    if (shape === undefined) continue;
    const byteLength =
      shape.reduce((product, size) => product * size, 1) *
      Float32Array.BYTES_PER_ELEMENT;
    if (offset + byteLength > buffer.byteLength) {
      throw new Error(`apply_correspondences response is truncated at ${key}`);
    }
    tensors[key] = {
      data: new Float32Array(buffer.slice(offset, offset + byteLength)),
      shape,
    };
    offset += byteLength;
  }
  if (tensors.field === undefined) {
    throw new Error("apply_correspondences response carries no field");
  }
  return { field: tensors.field, warpedImage: tensors.warpedImage };
}

export function warpedImageToUint8(
  image: FloatTensor,
): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(image.data, (value) =>
    Math.min(UINT8_MAX, Math.max(0, Math.round(value * UINT8_MAX))),
  );
}
