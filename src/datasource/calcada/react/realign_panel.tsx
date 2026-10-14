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

import type { RejectReason } from "#src/datasource/calcada/realign/realign_selection.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { Button } from "@/components/ui/button";

export interface RealignStatus {
  readonly kind: "idle" | "working" | "done" | "error";
  readonly message: string;
}

export interface RealignSummary {
  readonly hasBox: boolean;
  readonly lineCount: number;
  readonly rejected: readonly { id: string; reason: RejectReason }[];
  readonly unavailableReason?: string;
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
}

const REJECT_REASON_TEXT: Record<RejectReason, string> = {
  "outside-box": "an end is outside the box",
  "not-across-sections": "must join the box's section and the one below",
};

export function RealignPanel({ session }: { session: RealignPanelSession }) {
  const status = useWatchable(session.status);
  const summary = useWatchable(session.summary);
  const working = status.kind === "working";
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
          {summary.hasBox ? "Box drawn" : "No box"} · {summary.lineCount}{" "}
          correspondences
        </div>
        {summary.rejected.map(({ id, reason }) => (
          <div key={id} className="calcada-trace-panel-status">
            Line ignored: {REJECT_REASON_TEXT[reason]}
          </div>
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
          {working && (
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
        {status.message && (
          <div className="calcada-trace-panel-status">{status.message}</div>
        )}
      </fieldset>
    </div>
  );
}
