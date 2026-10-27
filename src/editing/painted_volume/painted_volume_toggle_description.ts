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
 * @file What the topbar's 3D-preview toggle says about the preview (plan §9.1).
 *
 * The tooltip carries everything a tracer needs to read the 3D panel: what is
 * shown, how far the region has loaded, the texture size, the downsampling,
 * and how to get slices and old meshes out of the way (§3.11).
 */

import type { PaintedVolumeUnavailableReason } from "#src/editing/painted_volume/painted_volume_preview.js";
import type { PaintedVolumePreviewSummary } from "#src/editing/painted_volume/painted_volume_preview_summary.js";

export interface PaintedVolumeToggleDescription {
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly tooltip: string;
  /** `"×2"` next to the toggle while the preview is downsampled. */
  readonly downsampleLabel: string | undefined;
}

const WHAT_IS_SHOWN =
  "Shows the selected segments in the 3D panel, like their meshes.";
const VIEW_HINTS =
  "To see inside, hide the slices: untick “Show cross sections in 3-d” " +
  "in the settings.\n" +
  "Old meshes of selected segments can be hidden in the segmentation layer.";

const UNAVAILABLE_REASONS: Record<PaintedVolumeUnavailableReason, string> = {
  "region-too-large":
    "the edit region is too large for the GPU, even downsampled.",
  "texture-allocation-failed": "the GPU could not allocate the texture.",
};

export function describePaintedVolumeToggle(
  summary: PaintedVolumePreviewSummary,
): PaintedVolumeToggleDescription {
  switch (summary.kind) {
    case "off":
      return {
        pressed: false,
        disabled: false,
        tooltip: `Show painted voxels in 3D\n${WHAT_IS_SHOWN}`,
        downsampleLabel: undefined,
      };
    case "waiting":
      return {
        pressed: true,
        disabled: false,
        tooltip: `Hide painted voxels in 3D\n${WHAT_IS_SHOWN}`,
        downsampleLabel: undefined,
      };
    case "unavailable":
      return {
        pressed: false,
        disabled: true,
        tooltip: `3D preview unavailable: ${UNAVAILABLE_REASONS[summary.reason]}`,
        downsampleLabel: undefined,
      };
    case "live":
      return describeLivePreview(summary);
  }
}

function describeLivePreview(
  summary: Extract<PaintedVolumePreviewSummary, { kind: "live" }>,
): PaintedVolumeToggleDescription {
  const { fill, textureBytes, factor } = summary;
  const isDownsampled = factor.some((axisFactor) => axisFactor > 1);
  const lines = ["Hide painted voxels in 3D", WHAT_IS_SHOWN];
  if (fill.done < fill.total) {
    lines.push(`Loading ${fill.done} / ${fill.total} chunks…`);
  }
  if (fill.failed > 0) {
    lines.push(`${fill.failed} chunks could not be read.`);
  }
  lines.push(
    `Preview texture: ${formatBytes(textureBytes)}` +
      (isDownsampled ? `, downsampled ${factor.join("×")}` : ""),
  );
  lines.push(VIEW_HINTS);
  return {
    pressed: true,
    disabled: false,
    tooltip: lines.join("\n"),
    downsampleLabel: isDownsampled ? `×${Math.max(...factor)}` : undefined,
  };
}

function formatBytes(bytes: number): string {
  const mebibyte = 1024 * 1024;
  if (bytes >= mebibyte) return `${(bytes / mebibyte).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}
