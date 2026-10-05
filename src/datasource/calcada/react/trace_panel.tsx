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

import { Fragment, useCallback } from "react";

import { MAIN_BRANCH_ID } from "#src/datasource/calcada/branch_picker_logic.js";
import { describePiece } from "#src/datasource/calcada/candidate_heat.js";
import type {
  CalcadaOverviewState,
  SplitDetectionFocus,
} from "#src/datasource/calcada/candidate_overview_state.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import type { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import { FilterNumberInput } from "#src/datasource/calcada/react/filter_number_input.js";
import { RejectedByPicker } from "#src/datasource/calcada/react/rejected_by_picker.js";
import { ScoreRangeSlider } from "#src/datasource/calcada/react/score_range_slider.js";
import { chooseTraceFilter } from "#src/datasource/calcada/trace_filter_choice.js";
import type {
  TraceScope,
  ZettaTraceState,
} from "#src/datasource/calcada/trace_state.js";
import {
  TRACE_SPHERE_RADIUS_MAX_NM,
  TRACE_SPHERE_RADIUS_MIN_NM,
} from "#src/datasource/calcada/trace_state.js";
import { useSignalRerender } from "#src/editing/ui/interop/react/use_signal_rerender.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { NullarySignal } from "#src/util/signal.js";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * What the panel needs from the graph connection, stated structurally so this
 * file never imports `frontend.ts` at runtime — that import is what would make
 * the module graph circular, since `frontend.ts` mounts this panel.
 */
export interface TracePanelConnection {
  readonly graph: { readonly branchId: WatchableValueInterface<number> };
  readonly state: {
    readonly zettaTraceState: ZettaTraceState;
    readonly overviewState: CalcadaOverviewState;
  };
  /** The segment being proofread, which Trace and detection both work on. */
  readonly segmentSession: {
    readonly changed: NullarySignal;
    readonly piece: bigint | undefined;
    /** A click in 2D is about to select it. */
    readonly picking: boolean;
    pick(): void;
    goTo(): void;
    clear(): void;
  };
  readonly overviewSession: {
    readonly changed: NullarySignal;
    readonly status: string;
    readonly focus: SplitDetectionFocus | undefined;
    previousPiece(): void;
    nextPiece(): void;
    showFocus(): void;
  };
  readonly traceSession: {
    readonly changed: NullarySignal;
    readonly status: string;
    readonly current: EdgeCandidate | undefined;
    readonly isBusy: boolean;
    reject(): void;
    canUndo(): boolean;
    skip(): void;
    start(): void;
    accept(): Promise<void>;
    undoLast(): Promise<void>;
  };
  listCandidateReviewers(): Promise<string[]>;
  readonly filterLibrary: FilterLibrary;
}

const NO_FILTER = "none";
const FROM_LINK = "link";

/**
 * Which saved filter Trace applies — always its saved version — and the way
 * into the editor column. A link can name someone else's filter; its tree
 * still applies, shown as coming from the link.
 */
function TraceFilterPicker({
  library,
  state,
}: {
  library: FilterLibrary;
  state: ZettaTraceState;
}) {
  useSignalRerender(library.changed);
  const presetId = useWatchable(state.filterPresetId);
  const editorOpen = useWatchable(state.filterEditor.watchableVisible);
  const filter = useWatchable(state.filter);
  const chosen = presetId === undefined ? undefined : library.nameOf(presetId);
  // A tree with no filter of the user's behind it (someone else's preset, an
  // older link) still applies; say where it came from rather than "none".
  const fromLink =
    chosen === undefined &&
    (presetId !== undefined || filter.children.length > 0);
  const value = chosen ?? (fromLink ? FROM_LINK : NO_FILTER);
  // "(from link)" is shown, never offered: an item that vanishes as the
  // user picks another makes the select report a change to "none".
  const options: [string, string][] = [
    [NO_FILTER, "— none —"],
    ...library.names.map((name): [string, string] => [name, name]),
  ];
  const shown = fromLink
    ? "(from link)"
    : (options.find(([key]) => key === value)?.[1] ?? "");
  const usingSaved = chosen !== undefined && library.isDirty(chosen);
  return (
    <div className="calcada-trace-filter">
      <Select
        value={value}
        onValueChange={(next) => {
          const name = next === NO_FILTER ? undefined : (next as string);
          chooseTraceFilter(state, library, name);
          // The editor opens on what Trace uses; the other way round, a
          // filter opened in the editor reaches Trace only by "Use in Trace".
          if (name !== undefined) library.select(name);
        }}
      >
        <SelectTrigger
          size="sm"
          className="calcada-trace-filter-select"
          aria-label="Candidate filter"
          title={chosen ?? (fromLink ? "From the link" : "No filter")}
        >
          <SelectValue>{shown}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ScoreRangeSlider range={state.scoreRange} />
      <div className="calcada-trace-filter-row">
        <Button
          size="xs"
          variant="outline"
          aria-expanded={editorOpen}
          onClick={() => {
            if (!editorOpen && chosen !== undefined) library.select(chosen);
            state.filterEditor.visible = !editorOpen;
          }}
        >
          {editorOpen ? "Close editor" : "Edit ▸"}
        </Button>
        {usingSaved && (
          <span
            className="calcada-filter-warning"
            title="This filter has unsaved edits in the editor; Trace uses the saved version."
          >
            using the saved version
          </span>
        )}
      </div>
    </div>
  );
}

const SCOPE_LABELS: ReadonlyArray<[TraceScope, string]> = [
  ["sphere", "sphere"],
  ["segment", "whole segment"],
];

/**
 * The keys the trace owns while it is running. Mirrors
 * ZETTA_TRACE_INPUT_EVENT_MAP and CALCADA_TRACE_AIM_INPUT_EVENT_MAP in
 * frontend.ts; the tab is the only place these are spelled out for a human
 * now, so a binding changed there has to be changed here too.
 */
// The binding is the physical US "/?" key, so it is named both ways.
const SPLIT_DETECTION_KEY = "? (Shift+/)";

const KEY_HINTS: ReadonlyArray<[string, string]> = [
  ["T", "start a trace"],
  ["Ctrl+click in 2D", "select the segment, after Select"],
  ["Ctrl+click", "place the sphere"],
  ["+ / −", "resize the sphere while placing"],
  ["+ / −", "raise / lower the lowest score"],
  ["→", "accept and merge"],
  ["←", "reject"],
  ["↓", "skip for now"],
  ["Ctrl+Z", "undo the last edit"],
  ["Esc", "put the seed down, then leave"],
  [SPLIT_DETECTION_KEY, "split error detection on / off"],
  ["← / →", "previous / next flagged piece"],
];

const NO_VALUE = "—";
const SCORE_DIGITS = 2;

function clampRadius(radiusNm: number): number {
  return Math.min(
    TRACE_SPHERE_RADIUS_MAX_NM,
    Math.max(TRACE_SPHERE_RADIUS_MIN_NM, radiusNm),
  );
}

/** One line that never wraps: a longer text is cut, and whole in its tooltip. */
function StatusLine({ text, picking }: { text: string; picking?: boolean }) {
  return (
    <div
      className={`calcada-trace-panel-status${picking ? " calcada-trace-panel-picking" : ""}`}
      title={text}
    >
      {text || NO_VALUE}
    </div>
  );
}

function SegmentSection({
  session,
}: {
  session: TracePanelConnection["segmentSession"];
}) {
  const { piece, picking } = session;
  const chosen = piece !== undefined;
  return (
    <fieldset className="calcada-trace-panel-section calcada-trace-panel-segment">
      <legend>Segment</legend>
      <StatusLine
        text={
          picking
            ? "Ctrl+click it in a 2D view"
            : chosen
              ? `Piece ${piece}`
              : "None"
        }
        picking={picking}
      />
      <div className="calcada-trace-panel-buttons">
        <Button
          size="xs"
          variant="outline"
          title="Ctrl+click the segment to proofread in a 2D view"
          onClick={() => session.pick()}
        >
          Select
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!chosen}
          title="Back to where the segment was selected"
          onClick={() => session.goTo()}
        >
          Go to
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!chosen}
          title="Forget the segment"
          onClick={() => session.clear()}
        >
          Clear
        </Button>
      </div>
    </fieldset>
  );
}

function TraceSection({ connection }: { connection: TracePanelConnection }) {
  const traceState = connection.state.zettaTraceState;
  const { traceSession } = connection;
  const aiming = useWatchable(traceState.aiming);
  const tracing = useWatchable(traceState.active);
  const scope = useWatchable(traceState.scope);
  const radiusNm = useWatchable(traceState.sphereRadiusNm);
  const centreOnCandidate = useWatchable(traceState.centreOnCandidate);
  const zoomOnCandidate = useWatchable(traceState.zoomOnCandidate);
  const busy = traceSession.isBusy;
  const verdictDisabled = busy || traceSession.current === undefined;
  return (
    <fieldset className="calcada-trace-panel-section">
      <legend>Trace</legend>
      <div className="calcada-trace-panel-header">
        <span className="calcada-trace-panel-badge">
          {aiming ? "Aiming" : tracing ? "Tracing" : "Idle"}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={tracing || aiming}
          title="Start a trace on the segment (T)"
          onClick={() => traceSession.start()}
        >
          Start
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!tracing && !aiming}
          title="Leave trace mode (Esc)"
          onClick={() => {
            traceState.aiming.value = false;
            traceState.active.value = false;
          }}
        >
          Exit
        </Button>
      </div>
      <StatusLine
        text={
          aiming
            ? "Ctrl+click on the segment to place the sphere"
            : tracing
              ? traceSession.status
              : ""
        }
      />

      <label className="calcada-trace-panel-row">
        Scope
        <Select
          value={scope}
          onValueChange={(next) => {
            traceState.scope.value = next as TraceScope;
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPE_LABELS.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="calcada-trace-panel-row">
        Sphere radius, nm
        <FilterNumberInput
          min={TRACE_SPHERE_RADIUS_MIN_NM}
          max={TRACE_SPHERE_RADIUS_MAX_NM}
          step={100}
          title="Radius of the sphere. Changing it after the seed is placed re-picks the candidates."
          disabled={scope === "segment"}
          value={Math.round(radiusNm)}
          onValueChange={(next) => {
            traceState.sphereRadiusNm.value = clampRadius(next);
          }}
        />
      </label>

      <label className="calcada-trace-panel-check">
        <input
          type="checkbox"
          checked={centreOnCandidate}
          onChange={(event) => {
            traceState.centreOnCandidate.value = event.target.checked;
          }}
        />
        Centre on each candidate
      </label>
      <label className="calcada-trace-panel-check">
        <input
          type="checkbox"
          checked={zoomOnCandidate}
          onChange={(event) => {
            traceState.zoomOnCandidate.value = event.target.checked;
          }}
        />
        Zoom the 3D view to each candidate
      </label>

      <div className="calcada-trace-panel-buttons">
        <Button
          size="xs"
          variant="outline"
          disabled={verdictDisabled}
          title="Reject this candidate (left arrow)"
          onClick={() => traceSession.reject()}
        >
          Reject
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={verdictDisabled}
          title="Skip for now, this session only (down arrow)"
          onClick={() => traceSession.skip()}
        >
          Skip
        </Button>
        <Button
          size="xs"
          disabled={verdictDisabled}
          title="Accept and merge (right arrow)"
          onClick={() => void traceSession.accept()}
        >
          Accept
        </Button>
        {/* Undo stays live with no candidate on screen: running out of
            candidates is exactly when someone notices the last merge was
            wrong. */}
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !traceSession.canUndo()}
          title="Take back the last edit (⌘/ctrl+Z)"
          onClick={() => void traceSession.undoLast()}
        >
          Undo
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * One flagged piece at a time, strongest first, so a proofreader is taken to
 * each likely split instead of hunting for red on a whole segment.
 */
function SplitDetectionSection({
  session,
  state,
  traceState,
}: {
  session: TracePanelConnection["overviewSession"];
  state: CalcadaOverviewState;
  traceState: ZettaTraceState;
}) {
  const active = useWatchable(state.active);
  const traceActive = useWatchable(traceState.active);
  const aiming = useWatchable(traceState.aiming);
  const tracing = traceActive || aiming;
  const focus = active ? session.focus : undefined;
  const piece = focus?.piece;
  return (
    <fieldset className="calcada-trace-panel-section calcada-trace-panel-detection">
      <legend>Split error detection</legend>
      <div className="calcada-trace-panel-buttons">
        <Button
          size="xs"
          variant="outline"
          disabled={active || tracing}
          title={`Mark likely split errors on the segment (${SPLIT_DETECTION_KEY})`}
          onClick={() => {
            state.active.value = true;
          }}
        >
          Detect split errors
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!active || tracing}
          title={`Remove the marks (${SPLIT_DETECTION_KEY})`}
          onClick={() => {
            state.active.value = false;
          }}
        >
          Clear
        </Button>
      </div>
      <StatusLine text={active ? session.status : ""} />
      <div className="calcada-trace-panel-legend">
        <span className="calcada-trace-panel-legend-scale" />
        <span>likely fine</span>
        <span>likely split</span>
      </div>
      <div className="calcada-trace-panel-navigator">
        <Button
          size="xs"
          variant="outline"
          disabled={focus === undefined}
          title="Previous flagged piece (left arrow)"
          onClick={() => session.previousPiece()}
        >
          ‹
        </Button>
        <button
          type="button"
          className="calcada-trace-panel-navigator-position"
          title="Go back to this piece"
          disabled={focus?.index === undefined}
          onClick={() => session.showFocus()}
        >
          {focus?.index === undefined ? NO_VALUE : focus.index + 1} /{" "}
          {focus?.total ?? NO_VALUE}
        </button>
        <Button
          size="xs"
          variant="outline"
          disabled={focus === undefined}
          title="Next flagged piece (right arrow)"
          onClick={() => session.nextPiece()}
        >
          ›
        </Button>
      </div>
      <div className="calcada-trace-panel-current">
        {piece === undefined
          ? NO_VALUE
          : `score ${piece.bestScore.toFixed(SCORE_DIGITS)} · ${describePiece({
              voxels: piece.voxelCount,
              classes: piece.classes,
              hasInfo: piece.hasInfo,
            })}`}
      </div>
    </fieldset>
  );
}

export function CalcadaTracePanel({
  connection,
}: {
  connection: TracePanelConnection;
}) {
  const traceState = connection.state.zettaTraceState;
  useSignalRerender(connection.traceSession.changed);
  useSignalRerender(connection.overviewSession.changed);
  useSignalRerender(connection.segmentSession.changed);

  const branchId = useWatchable(connection.graph.branchId);
  const rejectedBy = useWatchable(traceState.rejectedBy);
  // Stable, or the picker's fetch-on-mount would refire on every render.
  const loadReviewers = useCallback(
    () => connection.listCandidateReviewers(),
    [connection],
  );

  // A trace merges into the branch it runs on, so on main there is nothing to
  // configure — only the way out.
  if (branchId === MAIN_BRANCH_ID) {
    return (
      <div className="calcada-trace-panel">
        <div className="calcada-trace-panel-warning">
          Trace works on a branch only: every accept merges into the branch it
          runs on. Switch to a branch, or create one, with the Branch control —
          the segments you have selected come with you.
        </div>
      </div>
    );
  }

  return (
    <div className="calcada-trace-panel">
      <SegmentSection session={connection.segmentSession} />
      <TraceSection connection={connection} />

      {/* The filter both the trace and split error detection apply, so the
          pieces flagged as likely errors are the ones the trace will offer. */}
      <fieldset className="calcada-trace-panel-section">
        <legend>Candidate filter</legend>
        <TraceFilterPicker
          library={connection.filterLibrary}
          state={traceState}
        />
        {/* Proofreaders disagree, so whose rejections count is a setting
            rather than a rule. Nothing selected means anyone's. */}
        <div className="calcada-trace-panel-row">
          Skip rejected by
          <RejectedByPicker
            value={rejectedBy}
            onChange={(users) => {
              traceState.rejectedBy.value = users;
            }}
            loadReviewers={loadReviewers}
          />
        </div>
      </fieldset>

      <SplitDetectionSection
        session={connection.overviewSession}
        state={connection.state.overviewState}
        traceState={traceState}
      />

      <details className="calcada-trace-panel-keys-section">
        <summary>Keys</summary>
        <dl className="calcada-trace-panel-keys">
          {KEY_HINTS.map(([keys, meaning]) => (
            <Fragment key={`${keys} ${meaning}`}>
              <dt>{keys}</dt>
              <dd>{meaning}</dd>
            </Fragment>
          ))}
        </dl>
      </details>
    </div>
  );
}
