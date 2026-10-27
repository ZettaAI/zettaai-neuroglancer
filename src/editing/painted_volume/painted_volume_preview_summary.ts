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
 * @file One status for the 3D-preview toggle across every session layer.
 *
 * The toggle is session-wide while previews are per layer; this folds their
 * statuses into what the topbar shows (plan §9.1).
 */

import type {
  PaintedVolumePreviewStatus,
  PaintedVolumeUnavailableReason,
} from "#src/editing/painted_volume/painted_volume_preview.js";
import type { RegionFillProgress } from "#src/editing/painted_volume/painted_volume_region_fill.js";

type Triple = readonly [number, number, number];

export type PaintedVolumePreviewSummary =
  | { readonly kind: "off" }
  /** Enabled, but no preview exists yet (no session, or tools still wiring). */
  | { readonly kind: "waiting" }
  | {
      readonly kind: "unavailable";
      readonly reason: PaintedVolumeUnavailableReason;
    }
  | {
      readonly kind: "live";
      readonly fill: RegionFillProgress;
      readonly textureBytes: number;
      /** The coarsest factor per axis over all layers. */
      readonly factor: Triple;
    };

export function summarizePaintedVolumePreviews(
  enabled: boolean,
  statuses: Iterable<PaintedVolumePreviewStatus>,
): PaintedVolumePreviewSummary {
  if (!enabled) return { kind: "off" };
  let done = 0;
  let total = 0;
  let failed = 0;
  let textureBytes = 0;
  let factor: Triple | undefined;
  for (const status of statuses) {
    // One layer that cannot preview makes the toggle say so.
    if (status.kind === "unavailable") return status;
    done += status.fill.done;
    total += status.fill.total;
    failed += status.fill.failed;
    textureBytes += status.textureBytes;
    factor =
      factor === undefined ? status.factor : coarsest(factor, status.factor);
  }
  if (factor === undefined) return { kind: "waiting" };
  return { kind: "live", fill: { done, total, failed }, textureBytes, factor };
}

function coarsest(first: Triple, second: Triple): Triple {
  return [
    Math.max(first[0], second[0]),
    Math.max(first[1], second[1]),
    Math.max(first[2], second[2]),
  ];
}
