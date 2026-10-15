/** @jsxImportSource react */
/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useState } from "react";

import type { RealignCommitRow } from "#src/datasource/calcada/realign/realign_commit.js";
import { DEFAULT_MAX_SHIFT_PX } from "#src/datasource/calcada/realign/realign_commit.js";
import type { RejectReason } from "#src/datasource/calcada/realign/realign_selection.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { Button } from "@/components/ui/button";

export interface RealignStatus {
  readonly kind: "idle" | "working" | "committing" | "done" | "error";
  readonly message: string;
}

export interface RealignSummary {
  readonly hasBox: boolean;
  /** The section the box is on, when there is a box. */
  readonly boxSection?: number;
  readonly lineCount: number;
  readonly rejected: readonly { id: string; reason: RejectReason }[];
  readonly unavailableReason?: string;
  readonly arrows: readonly ArrowRow[];
  readonly residualMeanPx?: number;
  readonly onMain: boolean;
  /** An applied field matches the arrows and no commit is running. */
  readonly canCommit: boolean;
}

export interface ArrowRow {
  readonly id: string;
  readonly lengthPx: number;
  /** The sections of the arrow's tail and head. */
  readonly sections: readonly [number, number];
  readonly residualPx?: number;
  readonly rejected?: RejectReason;
}

/**
 * What the panel needs from the realign session, stated structurally so this
 * file never imports `frontend.ts`, which mounts it.
 */
export interface RealignPanelSession {
  readonly status: WatchableValueInterface<RealignStatus>;
  readonly summary: WatchableValueInterface<RealignSummary>;
  drawBox(): void;
  addCorrespondence(): void;
  apply(): Promise<void>;
  clearPreview(): void;
  cancel(): void;
  focusArrow(id: string): void;
  removeAllArrows(): void;
  plannedSections(maxShiftPx: number): number | undefined;
  commit(maxShiftPx: number): Promise<void>;
  /** The branch's realigns, newest first. */
  readonly commits: WatchableValueInterface<readonly RealignCommitRow[]>;
  undo(operationId: number): Promise<void>;
}

const PIXEL_DIGITS = 1;

function pixels(value: number): string {
  return `${value.toFixed(PIXEL_DIGITS)} px`;
}

function rejectionText(
  reason: RejectReason,
  [tail, head]: readonly [number, number],
  boxSection: number | undefined,
): string {
  if (reason === "outside-box") return "an end is outside the box";
  const needed =
    boxSection === undefined ? "" : `, needs ${boxSection} → ${boxSection - 1}`;
  return `on z ${tail} → ${head}${needed}`;
}

function correspondenceCount({
  hasBox,
  boxSection,
  arrows,
  rejected,
}: RealignSummary): string {
  const box = hasBox ? `Box on z ${boxSection}` : "No box";
  const rejectedNote =
    rejected.length > 0 ? ` · ${rejected.length} rejected` : "";
  return `${box} · ${arrows.length} correspondences${rejectedNote}`;
}

const UNDO_PENDING_STATUS = "undo_pending";

function commitLabel({ operationId, box, z0, sections }: RealignCommitRow) {
  const [x0, y0, x1, y1] = box;
  return `#${operationId} · z ${z0}–${z0 + sections - 1} · ${x0},${y0} → ${x1},${y1}`;
}

function commitNote({ status, blockedBy }: RealignCommitRow) {
  if (blockedBy !== undefined) return ` · undo #${blockedBy} first`;
  if (status === UNDO_PENDING_STATUS) return " · undo unfinished";
  return "";
}

export function RealignPanel({ session }: { session: RealignPanelSession }) {
  const status = useWatchable(session.status);
  const summary = useWatchable(session.summary);
  const commits = useWatchable(session.commits);
  const [maxShiftPx, setMaxShiftPx] = useState(DEFAULT_MAX_SHIFT_PX);
  const [confirming, setConfirming] = useState(false);
  const working = status.kind === "working" || status.kind === "committing";
  const canApply =
    !working &&
    summary.unavailableReason === undefined &&
    summary.hasBox &&
    summary.lineCount > 0;

  return (
    <div className="calcada-trace-panel calcada-realign-panel">
      {summary.unavailableReason !== undefined && (
        <div className="calcada-trace-panel-warning">
          {summary.unavailableReason}
        </div>
      )}
      <fieldset className="calcada-trace-panel-section">
        <legend>Correspondences</legend>
        <div className="calcada-trace-panel-status">
          {correspondenceCount(summary)}
        </div>
        {summary.arrows.map((arrow, index) => (
          <button
            key={arrow.id}
            type="button"
            className="calcada-trace-panel-row"
            data-arrow-id={arrow.id}
            title="Go to this correspondence"
            onClick={() => session.focusArrow(arrow.id)}
          >
            #{index + 1} · {pixels(arrow.lengthPx)}
            {arrow.rejected !== undefined
              ? ` · ${rejectionText(arrow.rejected, arrow.sections, summary.boxSection)}`
              : arrow.residualPx !== undefined
                ? ` → ${pixels(arrow.residualPx)}`
                : ""}
          </button>
        ))}
        <div className="calcada-trace-panel-buttons">
          <Button
            size="xs"
            variant="outline"
            title="Drag a box on the misaligned section"
            onClick={() => session.drawBox()}
          >
            Draw box
          </Button>
          <Button
            size="xs"
            variant="outline"
            title="Draw a line from a feature on the box's section to where it belongs on the section below"
            onClick={() => session.addCorrespondence()}
          >
            Add correspondence
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={summary.arrows.length === 0}
            title="Delete every correspondence"
            onClick={() => session.removeAllArrows()}
          >
            Remove all
          </Button>
        </div>
      </fieldset>
      <fieldset className="calcada-trace-panel-section">
        <legend>Preview</legend>
        <div className="calcada-trace-panel-buttons">
          <Button
            size="xs"
            disabled={!canApply}
            title="Compute the field and show the warped section"
            onClick={() => void session.apply()}
          >
            Apply
          </Button>
          {status.kind === "working" && (
            <Button
              size="xs"
              variant="outline"
              title="Stop waiting for this Apply"
              onClick={() => session.cancel()}
            >
              Cancel
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            title="Remove the preview layer"
            onClick={() => session.clearPreview()}
          >
            Clear preview
          </Button>
        </div>
        {summary.residualMeanPx !== undefined && (
          <div className="calcada-trace-panel-status">
            Mean residual after warp: {pixels(summary.residualMeanPx)}
          </div>
        )}
        {status.message && (
          <div className="calcada-trace-panel-status">{status.message}</div>
        )}
      </fieldset>
      <fieldset className="calcada-trace-panel-section">
        <legend>Commit</legend>
        {summary.onMain && (
          <div className="calcada-trace-panel-warning">
            Commits are made on a branch. Switch to a branch, or create one,
            with the Branch control.
          </div>
        )}
        <label className="calcada-trace-panel-row">
          Max shift between sections, px
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={maxShiftPx}
            onChange={(event) => setMaxShiftPx(Number(event.target.value))}
          />
        </label>
        {confirming ? (
          <>
            <div className="calcada-trace-panel-status">
              Changes {session.plannedSections(maxShiftPx) ?? "?"} sections on
              this branch.
            </div>
            <div className="calcada-trace-panel-buttons">
              <Button
                size="xs"
                onClick={() => {
                  setConfirming(false);
                  void session.commit(maxShiftPx);
                }}
              >
                Confirm
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setConfirming(false)}
              >
                Back
              </Button>
            </div>
          </>
        ) : (
          <div className="calcada-trace-panel-buttons">
            <Button
              size="xs"
              disabled={
                !summary.canCommit ||
                summary.onMain ||
                working ||
                !(maxShiftPx > 0)
              }
              title="Write the warp into this branch over the box's section and the ones above"
              onClick={() => setConfirming(true)}
            >
              Commit
            </Button>
          </div>
        )}
      </fieldset>
      <fieldset className="calcada-trace-panel-section">
        <legend>Commits</legend>
        {commits.length === 0 && (
          <div className="calcada-trace-panel-status">
            No commits on this branch.
          </div>
        )}
        {commits.map((row) => (
          <div
            key={row.operationId}
            className="calcada-trace-panel-row"
            data-commit-id={row.operationId}
          >
            <span>
              {commitLabel(row)}
              {commitNote(row)}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={!row.undoable || working}
              title="Restore the image, segmentation and graph from before this realign"
              onClick={() => void session.undo(row.operationId)}
            >
              Undo
            </Button>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
