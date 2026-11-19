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
 * @file The z-extrapolation panel's segment list (TM-518).
 *
 * One row per listed segment: a crosshair toggle (tracked = propagated by the
 * next run), then NG's own segment-list row for the segment — the ID chip in
 * its viewer colour, visibility, star, copy — mounted by the host, so colour
 * and hover behave exactly as in the layer's segment list. The toggle is
 * deliberately not a checkbox: in the NG segment list a checkbox means
 * "shown", and tracking is a different thing — untracking never hides a
 * segment, it leaves it out of the run and keeps its voxels.
 *
 * Presentational: rows and tracking come from the tool, the NG row from the
 * host, through the props.
 */

import { Crosshair } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type { ZExtrapolationSegmentRow } from "#src/editing/tool_runtimes/z_extrapolation_tool.js";
import "#src/editing/ui/tool_settings/tracked_segment_list.css";

type Props = {
  rows: readonly ZExtrapolationSegmentRow[];
  /** Most segments one run can track. */
  maxTracked: number;
  /**
   * Mount NG's segment-list row for a segment into `parent`; returns the
   * unmount, or `undefined` when the layer is not resolved (the plain ID is
   * shown instead).
   */
  mountSegment: (parent: HTMLElement, id: bigint) => (() => void) | undefined;
  canAutoDetect: boolean;
  onAutoDetect: () => void;
  onSetTracked: (id: bigint, isTracked: boolean) => void;
  onSetAllTracked: (isTracked: boolean) => void;
};

export function TrackedSegmentList({
  rows,
  maxTracked,
  mountSegment,
  canAutoDetect,
  onAutoDetect,
  onSetTracked,
  onSetAllTracked,
}: Props) {
  const trackedCount = rows.filter((row) => row.isTracked).length;
  const excess = trackedCount - maxTracked;

  return (
    <div class="neuroglancer-tracked-segments">
      <div class="neuroglancer-tracked-segments-head">
        <span>
          {rows.length === 0
            ? "No segments tracked"
            : `Tracking ${trackedCount} of ${rows.length}`}
        </span>
        <button
          type="button"
          disabled={!canAutoDetect}
          data-tooltip="Show and track every segment on the current slice of the region"
          onClick={onAutoDetect}
        >
          Auto-detect (Z)
        </button>
      </div>

      {rows.length === 0 ? (
        <div class="neuroglancer-tracked-segments-empty">
          Double-click segments in the viewer, or use Auto-detect.
        </div>
      ) : (
        <>
          <div class="neuroglancer-tracked-segments-bulk">
            <span>Track</span>
            <button
              type="button"
              disabled={trackedCount === rows.length}
              onClick={() => onSetAllTracked(true)}
            >
              All
            </button>
            <button
              type="button"
              disabled={trackedCount === 0}
              onClick={() => onSetAllTracked(false)}
            >
              None
            </button>
          </div>
          <ul class="neuroglancer-tracked-segments-list">
            {rows.map((row) => (
              <SegmentRow
                key={String(row.id)}
                row={row}
                mountSegment={mountSegment}
                onToggle={() => onSetTracked(row.id, !row.isTracked)}
              />
            ))}
          </ul>
          {excess > 0 && (
            <div class="neuroglancer-tracked-segments-limit" role="alert">
              At most {maxTracked} segments per run — untrack {excess} more.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SegmentRow({
  row,
  mountSegment,
  onToggle,
}: {
  row: ZExtrapolationSegmentRow;
  mountSegment: Props["mountSegment"];
  onToggle: () => void;
}) {
  return (
    <li
      class="neuroglancer-tracked-segments-row"
      data-tracked={row.isTracked ? "true" : "false"}
    >
      <button
        type="button"
        class="neuroglancer-tracked-segments-target"
        aria-pressed={row.isTracked ? "true" : "false"}
        aria-label={`Track segment ${row.id}`}
        data-tooltip={
          row.isTracked
            ? "Tracked — click to leave it out of the next run (its voxels are kept)"
            : "Not tracked — kept as it is; click to track"
        }
        onClick={onToggle}
      >
        <Crosshair size={13} aria-hidden="true" />
      </button>
      <NativeSegmentRow id={row.id} mountSegment={mountSegment} />
      {row.isMerged && (
        <span
          class="neuroglancer-tracked-segments-badge"
          data-tooltip="Merged with other segments — z-extrapolation tracks unmerged segments only"
        >
          merged
        </span>
      )}
      {row.isHidden && (
        <span
          class="neuroglancer-tracked-segments-badge"
          data-tooltip="Hidden in the viewer — still propagated while tracked"
        >
          hidden
        </span>
      )}
    </li>
  );
}

/**
 * NG's segment-list row for `id`, mounted by the host into a slot Preact
 * leaves alone; the plain ID until (unless) the host can mount it.
 */
function NativeSegmentRow({
  id,
  mountSegment,
}: {
  id: bigint;
  mountSegment: Props["mountSegment"];
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [isMounted, setMounted] = useState(false);
  useEffect(() => {
    const unmount = mountSegment(slot.current!, id);
    setMounted(unmount !== undefined);
    return unmount;
  }, [mountSegment, id]);
  return (
    <div class="neuroglancer-tracked-segments-native">
      <div ref={slot} />
      {!isMounted && (
        <span class="neuroglancer-tracked-segments-id">{String(id)}</span>
      )}
    </div>
  );
}
