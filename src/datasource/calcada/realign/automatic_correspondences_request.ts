/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Wire format of web_api's `POST /alignment/compute_automatic_correspondences`,
 * as the portal's correspondence tool sends it: SIFT matches between the box's
 * crop on the moving section and on the reference section, without RANSAC, so
 * a local, non-affine slip keeps its matches. Points are crop pixels `[y, x]`,
 * `start` on the moving section.
 */

import type { RealignCrop } from "#src/datasource/calcada/realign/realign_client.js";
import type { CorrespondenceLine } from "#src/datasource/calcada/realign/realign_selection.js";

export const AUTOMATIC_CORRESPONDENCES_PATH =
  "/alignment/compute_automatic_correspondences";

// web_api's own default; the arrow list stays readable at this size.
const AUTOMATIC_CORRESPONDENCE_COUNT = 200;
/** Matches this close to the crop's edge are dropped: the field is pinned to zero there. */
export const CROP_EDGE_MARGIN_PX = 16;

export interface CropCorrespondence {
  readonly start: [number, number];
  readonly end: [number, number];
}

/** `existing` lines keep SIFT from adding matches right beside them. */
export function buildAutomaticCorrespondencesForm(
  moving: RealignCrop,
  reference: RealignCrop,
  existing: readonly CorrespondenceLine[],
): FormData {
  const metadata = {
    src_image_shape: [moving.height, moving.width],
    tgt_image_shape: [reference.height, reference.width],
    num_correspondences: AUTOMATIC_CORRESPONDENCE_COUNT,
    ...(existing.length === 0
      ? {}
      : {
          existing_correspondences: existing.map(({ start, end }) => ({
            start,
            end,
          })),
        }),
  };
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  form.append("src-image-data", imageBlob(moving), "src");
  form.append("tgt-image-data", imageBlob(reference), "tgt");
  return form;
}

function imageBlob(crop: RealignCrop): Blob {
  return new Blob([crop.data as Uint8Array<ArrayBuffer>], {
    type: "application/octet-stream",
  });
}

export function parseAutomaticCorrespondences(
  body: unknown,
  crop: RealignCrop,
): CropCorrespondence[] {
  const { lines } = body as {
    lines: { start: readonly number[]; end: readonly number[] }[];
  };
  return lines
    .map(
      ({ start: [startY, startX], end: [endY, endX] }): CropCorrespondence => ({
        start: [startY, startX],
        end: [endY, endX],
      }),
    )
    .filter(
      ({ start, end }) => awayFromEdge(start, crop) && awayFromEdge(end, crop),
    );
}

function awayFromEdge(
  [y, x]: readonly [number, number],
  { width, height }: RealignCrop,
): boolean {
  return (
    y >= CROP_EDGE_MARGIN_PX &&
    x >= CROP_EDGE_MARGIN_PX &&
    y < height - CROP_EDGE_MARGIN_PX &&
    x < width - CROP_EDGE_MARGIN_PX
  );
}
