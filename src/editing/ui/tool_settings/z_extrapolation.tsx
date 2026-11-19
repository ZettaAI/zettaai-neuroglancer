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
 * @file Z-extrapolation tool settings panel (TM-326).
 *
 * Presentational: all logic lives on `host.zExtrapolation` (the tool + run
 * controller). The panel reads its reactive state, offers layer/direction/Z
 * controls, lists the segments (the mask layer's selection) with their colours
 * and a track/untrack tick each (TM-518), and drives Auto-detect / Run / Reset.
 * Run is gated on the backend being reachable. Current Z always follows the
 * viewport; typing a Z moves the viewport there. Every control is rendered in
 * every state, so the layout does not shift while a run is in flight.
 */

import type { EditSession, LayerId } from "@zettaai/edit-session";
import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { MAX_TRACKED_SEGMENTS } from "#src/editing/tool_runtimes/mask_label_codec.js";
import type {
  ConfirmOverLimit,
  ZExtrapolationTool,
} from "#src/editing/tool_runtimes/z_extrapolation_tool.js";
import { ConfirmDialog } from "#src/editing/ui/confirm_dialog.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { layerKindOf } from "#src/editing/ui/layer_kind.js";
import { ParamInput } from "#src/editing/ui/tool_settings/param_input.js";
import { ToolPanelKeys } from "#src/editing/ui/tool_settings/tool_panel_keys.js";
import { TrackedSegmentList } from "#src/editing/ui/tool_settings/tracked_segment_list.js";
import "#src/editing/ui/tool_settings/z_extrapolation.css";

type Props = { session: EditSession; host: EditSessionHost };

/** Parse a non-negative integer Z, or null for empty/invalid input. */
function parseCurrentZ(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : null;
}

export function ZExtrapolation({ host }: Props) {
  // The tools are (re)built asynchronously after `openSession`; re-read on the
  // signal so the panel picks up `host.zExtrapolation` once it exists.
  useEvent(useCallback((h: () => void) => host.toolingChanged.add(h), [host]));
  const tool = host.zExtrapolation;
  if (tool === undefined) {
    return (
      <div class="neuroglancer-tool-panel neuroglancer-z-extrapolation-panel">
        <p class="neuroglancer-tool-panel-placeholder">Preparing…</p>
      </div>
    );
  }
  return <ZExtrapolationBody tool={tool} host={host} />;
}

function ZExtrapolationBody({
  tool,
  host,
}: {
  tool: ZExtrapolationTool;
  host: EditSessionHost;
}) {
  useEvent(useCallback((h: () => void) => tool.changed.add(h), [tool]));
  useWatchable(host.state.value);
  const backendAvailable = useWatchable(host.backendAvailable);
  const backendAuthExpired = useWatchable(host.backendAuthExpired);

  const layerManager = host.viewer.layerManager;
  const intent = host.state.value.value;
  const state = tool.getState();

  const imageLayers: LayerId[] =
    intent === null
      ? []
      : intent.layers
          .filter(
            (l) =>
              layerKindOf(layerManager.getLayerByName(l.layerId)) === "image",
          )
          .map((l) => l.layerId);
  const maskLayers: LayerId[] =
    intent === null
      ? []
      : intent.layers
          .filter(
            (l) =>
              l.writable &&
              layerKindOf(layerManager.getLayerByName(l.layerId)) ===
                "segmentation",
          )
          .map((l) => l.layerId);

  // Default the pickers to the first candidate of each kind (idempotent).
  const firstImage = imageLayers[0];
  const firstMask = maskLayers[0];
  useEffect(() => {
    if (state.maskLayerId === undefined && firstMask !== undefined) {
      tool.setMaskLayer(firstMask);
    }
    if (state.imageLayerId === undefined && firstImage !== undefined) {
      tool.setImageLayer(firstImage);
    }
  }, [tool, state.maskLayerId, state.imageLayerId, firstMask, firstImage]);

  // Current Z follows the viewport.
  useEffect(() => {
    const position = host.viewer.position;
    tool.followViewportZ();
    return position.changed.add(() => tool.followViewportZ());
  }, [tool, host]);

  // Re-render when the mask layer's selection (the listed segments), which of
  // them are shown, or their colours change.
  const maskLayerId = state.maskLayerId;
  useEvent(
    useCallback(
      (h: () => void) =>
        maskLayerId === undefined
          ? () => {}
          : host.onSegmentDisplayChanged(maskLayerId, h),
      [maskLayerId, host],
    ),
  );
  // Stable per layer, so a re-render does not remount the NG rows.
  const mountSegment = useCallback(
    (parent: HTMLElement, id: bigint) =>
      maskLayerId === undefined
        ? undefined
        : host.mountSegmentListWidget(maskLayerId, parent, id),
    [maskLayerId, host],
  );
  const overLimit = useOverLimitConfirm();
  const rows = tool.segmentRows();
  const trackedCount = rows.filter((row) => row.isTracked).length;

  // Backend reachability is host-level; every domain reason (layers, tracked
  // segments, current/next slice in region) comes from the tool so the button
  // and the action share one source of truth — a next slice outside the region
  // disables Run rather than erroring on click.
  const disabledReason = !backendAvailable
    ? "Backend is not available."
    : backendAuthExpired
      ? "Session expired — sign in again."
      : tool.runDisabledReason();
  const canRun = disabledReason === undefined && !state.isRunning;

  const onSelectChange = (set: (id: LayerId) => void) => (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value !== "") set(value as LayerId);
  };

  return (
    <div class="neuroglancer-tool-panel neuroglancer-z-extrapolation-panel">
      <div class="neuroglancer-tool-panel-row">
        <label>Segmentation</label>
        <select
          value={state.maskLayerId ?? ""}
          onChange={onSelectChange((id) => tool.setMaskLayer(id))}
        >
          <option value="">— Select —</option>
          {maskLayers.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      <div class="neuroglancer-tool-panel-row">
        <label>Image</label>
        <select
          value={state.imageLayerId ?? ""}
          onChange={onSelectChange((id) => tool.setImageLayer(id))}
        >
          <option value="">— Select —</option>
          {imageLayers.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>

      <div class="neuroglancer-tool-panel-row">
        <label>Direction</label>
        <select
          value={state.direction}
          onChange={(e) =>
            tool.setDirection(
              (e.currentTarget as HTMLSelectElement).value === "backward"
                ? "backward"
                : "forward",
            )
          }
        >
          <option value="forward">Forward (+Z)</option>
          <option value="backward">Backward (−Z)</option>
        </select>
      </div>

      <div class="neuroglancer-tool-panel-row">
        <label>Current Z</label>
        <ParamInput<number>
          type="number"
          min={0}
          step={1}
          value={state.currentZ ?? 0}
          parse={parseCurrentZ}
          onCommit={(z) => tool.setCurrentZ(z)}
        />
      </div>

      <TrackedSegmentList
        rows={rows}
        maxTracked={MAX_TRACKED_SEGMENTS}
        mountSegment={mountSegment}
        canAutoDetect={maskLayerId !== undefined}
        onAutoDetect={() => void tool.autoDetectTrackedSegments(overLimit.ask)}
        onSetTracked={(id, isTracked) => tool.setSegmentTracked(id, isTracked)}
        onSetAllTracked={(isTracked) => tool.setAllSegmentsTracked(isTracked)}
      />
      {overLimit.dialog}

      <button
        type="button"
        class="neuroglancer-z-extrapolation-run"
        disabled={!canRun}
        data-tooltip={disabledReason}
        onClick={() => void tool.runNextSlice()}
      >
        {state.isRunning
          ? "Running…"
          : canRun
            ? `Run next slice (${trackedCount} ${trackedCount === 1 ? "segment" : "segments"})`
            : "Run next slice"}
      </button>
      <button
        type="button"
        class="neuroglancer-z-extrapolation-cancel"
        disabled={!state.isRunning}
        onClick={() => tool.cancel()}
      >
        Cancel
      </button>
      <button
        type="button"
        class="neuroglancer-z-extrapolation-reset"
        disabled={!state.hasLastRun || state.isRunning}
        data-tooltip="Undo the last propagation and return to the previous slice"
        onClick={() => void tool.resetLastRun()}
      >
        Reset
      </button>
      <ToolPanelKeys host={host} toolId="z-extrapolation" />
    </div>
  );
}

interface PendingOverLimit {
  readonly detectedCount: number;
  readonly trackedAfter: number;
  readonly answer: (proceed: boolean) => void;
}

/**
 * The confirmation auto-detect asks for when it would track more segments
 * than one run carries (TM-518). `ask` opens the dialog and resolves with the
 * answer; walking away (Escape, backdrop, the panel closing) means "no".
 */
function useOverLimitConfirm(): {
  ask: ConfirmOverLimit;
  dialog: JSX.Element | null;
} {
  const [pending, setPending] = useState<PendingOverLimit | undefined>();
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current?.answer(false), []);

  const ask: ConfirmOverLimit = ({ detectedCount, trackedAfter }) =>
    new Promise((resolve) => {
      setPending({
        detectedCount,
        trackedAfter,
        answer: (proceed) => {
          setPending(undefined);
          resolve(proceed);
        },
      });
    });

  const dialog =
    pending === undefined ? null : (
      <ConfirmDialog
        open
        title="Track this many segments?"
        message={
          `Auto-detect found ${pending.detectedCount} segments on this slice. ` +
          `Adding them selects and shows them all and tracks ` +
          `${pending.trackedAfter} segments — more than the ` +
          `${MAX_TRACKED_SEGMENTS} one run can carry, so you would untrack ` +
          `some before running.`
        }
        confirmLabel="Add segments"
        onConfirm={() => pending.answer(true)}
        onCancel={() => pending.answer(false)}
      />
    );
  return { ask, dialog };
}
