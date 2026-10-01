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
  SplitErrorDisplay,
} from "#src/datasource/calcada/candidate_overview_state.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import type { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import { FilterNumberInput } from "#src/datasource/calcada/react/filter_number_input.js";
import { RejectedByPicker } from "#src/datasource/calcada/react/rejected_by_picker.js";
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
  readonly overviewSession: {
    readonly changed: NullarySignal;
    readonly status: string;
    readonly focus: SplitDetectionFocus | undefined;
    readonly hasSeed: boolean;
    previousPiece(): void;
    nextPiece(): void;
    showFocus(): void;
    clearSeed(): void;
    /** A click in 2D is about to pick the segment. */
    readonly picking: boolean;
    pickSegment(): void;
  };
  readonly traceSession: {
    readonly changed: NullarySignal;
    readonly status: string;
    readonly current: EdgeCandidate | undefined;
    readonly isBusy: boolean;
    reject(): void;
    canUndo(): boolean;
    skip(): void;
    goToSeed(): void;
    clearSeed(): void;
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
const KEY_HINTS: ReadonlyArray<[string, string]> = [
  ["T", "place a seed"],
  ["Ctrl+click", "put it on the mesh under the cursor"],
  ["+ / −", "resize the sphere while placing"],
  ["→", "accept and merge"],
  ["←", "reject"],
  ["↓", "skip for now"],
  ["Ctrl+Z", "undo the last edit"],
  ["Esc", "put the seed down, then leave"],
  ["E", "split error detection on / off"],
  ["Ctrl+click in 2D", "choose the segment to check"],
  ["← / →", "previous / next flagged piece, by score"],
];

function clampRadius(radiusNm: number): number {
  return Math.min(
    TRACE_SPHERE_RADIUS_MAX_NM,
    Math.max(TRACE_SPHERE_RADIUS_MIN_NM, radiusNm),
  );
}

/**
 * One flagged piece at a time, strongest first, so a proofreader is taken to
 * each likely split instead of hunting for red on a whole segment.
 */
const SPLIT_DISPLAY_LABELS: ReadonlyArray<[SplitErrorDisplay, string]> = [
  ["pieces", "Coloured pieces"],
  ["points", "Red points"],
];

function SplitDetectionNavigator({
  session,
  state,
}: {
  session: TracePanelConnection["overviewSession"];
  state: CalcadaOverviewState;
}) {
  const { focus } = session;
  const display = useWatchable(state.display);
  return (
    <>
      <div className="calcada-trace-panel-row">
        <span>Show flagged pieces as</span>
        <Select
          value={display}
          onValueChange={(value) => {
            state.display.value = value as SplitErrorDisplay;
          }}
        >
          <SelectTrigger
            size="sm"
            className="calcada-trace-panel-split-display"
            aria-label="Show flagged pieces as"
          >
            <SelectValue>
              {SPLIT_DISPLAY_LABELS.find(([key]) => key === display)?.[1]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SPLIT_DISPLAY_LABELS.map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div
        className={`calcada-trace-panel-status${session.picking ? " calcada-trace-panel-picking" : ""}`}
      >
        {session.status}
      </div>
      {focus !== undefined && (
        <div className="calcada-trace-panel-navigator">
          <Button
            size="xs"
            variant="outline"
            title="Previous flagged piece (left arrow)"
            onClick={() => session.previousPiece()}
          >
            ‹
          </Button>
          <button
            type="button"
            className="calcada-trace-panel-navigator-position"
            title="Go back to this piece"
            disabled={focus.index === undefined}
            onClick={() => session.showFocus()}
          >
            {focus.index === undefined ? "–" : focus.index + 1} / {focus.total}
          </button>
          <Button
            size="xs"
            variant="outline"
            title="Next flagged piece (right arrow)"
            onClick={() => session.nextPiece()}
          >
            ›
          </Button>
        </div>
      )}
      {focus?.piece !== undefined && (
        <div className="calcada-trace-panel-current">
          score {focus.piece.bestScore.toFixed(2)} ·{" "}
          {describePiece({
            voxels: focus.piece.voxelCount,
            classes: focus.piece.classes,
            hasInfo: focus.piece.hasInfo,
          })}
        </div>
      )}
      <div className="calcada-trace-panel-buttons">
        {!session.picking && (
          <Button
            size="xs"
            variant="outline"
            title="Click a segment in a 2D view to check it"
            onClick={() => session.pickSegment()}
          >
            Pick segment
          </Button>
        )}
        {session.hasSeed && (
          <Button
            size="xs"
            variant="outline"
            title="Forget the segment"
            onClick={() => session.clearSeed()}
          >
            Clear segment
          </Button>
        )}
      </div>
    </>
  );
}

export function CalcadaTracePanel({
  connection,
}: {
  connection: TracePanelConnection;
}) {
  const traceState = connection.state.zettaTraceState;
  const overviewState = connection.state.overviewState;
  const { traceSession } = connection;
  useSignalRerender(traceSession.changed);
  useSignalRerender(connection.overviewSession.changed);

  const aiming = useWatchable(traceState.aiming);
  const scope = useWatchable(traceState.scope);
  const tracing = useWatchable(traceState.active);
  const branchId = useWatchable(connection.graph.branchId);
  const radiusNm = useWatchable(traceState.sphereRadiusNm);
  const seedCenter = useWatchable(traceState.sphereCenter);
  const rejectedBy = useWatchable(traceState.rejectedBy);
  // Stable, or the picker's fetch-on-mount would refire on every render.
  const loadReviewers = useCallback(
    () => connection.listCandidateReviewers(),
    [connection],
  );
  const centreOnCandidate = useWatchable(traceState.centreOnCandidate);
  const zoomOnCandidate = useWatchable(traceState.zoomOnCandidate);
  const overviewActive = useWatchable(overviewState.active);

  const busy = traceSession.isBusy;
  const verdictDisabled = busy || traceSession.current === undefined;

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
      <div className="calcada-trace-panel-header">
        <span className="calcada-trace-panel-badge">
          {aiming ? "Aiming" : tracing ? "Tracing" : "Trace"}
        </span>
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

      <div className="calcada-trace-panel-status">
        {aiming
          ? "Point at a mesh and Ctrl+click to place the sphere. + / − resize it."
          : tracing
            ? traceSession.status
            : "Press T, then click a mesh to start a trace."}
      </div>

      <label className="calcada-trace-panel-row">
        Seed scope
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

      {seedCenter !== undefined && (
        <div className="calcada-trace-panel-seed">
          <span className="calcada-trace-panel-seed-position">
            Seed at{" "}
            {Array.from(seedCenter)
              .map((value) => Math.round(value))
              .join(", ")}
          </span>
          <span className="calcada-trace-panel-buttons">
            <Button
              size="xs"
              variant="outline"
              title="Move the view back to the seed"
              onClick={() => traceSession.goToSeed()}
            >
              Go to
            </Button>
            <Button
              size="xs"
              variant="outline"
              title="Drop the seed and end the trace"
              onClick={() => traceSession.clearSeed()}
            >
              Clear
            </Button>
          </span>
        </div>
      )}

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

      {/* Proofreaders disagree, so whose rejections count is a setting rather
          than a rule. Nothing selected means anyone's. */}
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

      {/* The filter both the trace and split error detection apply, so the
          pieces painted as likely errors are the ones the trace will offer. */}
      <fieldset className="calcada-trace-panel-section">
        <legend>Candidate filter</legend>
        <TraceFilterPicker
          library={connection.filterLibrary}
          state={traceState}
        />
        {tracing && traceSession.current !== undefined && (
          <>
            <div className="calcada-trace-panel-current">
              Seed piece:{" "}
              {describePiece({
                voxels: traceSession.current.selfVoxels,
                classes: traceSession.current.selfClasses,
                hasInfo: traceSession.current.selfHasInfo,
              })}
            </div>
            <div className="calcada-trace-panel-current">
              Candidate:{" "}
              {describePiece({
                voxels: traceSession.current.partnerVoxels,
                classes: traceSession.current.partnerClasses,
                hasInfo: traceSession.current.partnerHasInfo,
              })}
            </div>
          </>
        )}
      </fieldset>

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

      <div className="calcada-trace-panel-overview">
        <label className="calcada-trace-panel-check">
          <input
            type="checkbox"
            checked={overviewActive}
            onChange={(event) => {
              overviewState.active.value = event.target.checked;
            }}
          />
          Split error detection
        </label>
        <div className="calcada-trace-panel-legend">
          <span className="calcada-trace-panel-legend-scale" />
          <span>likely fine</span>
          <span>likely split</span>
        </div>

        {overviewActive && (
          <SplitDetectionNavigator
            session={connection.overviewSession}
            state={overviewState}
          />
        )}
      </div>

      <dl className="calcada-trace-panel-keys">
        {KEY_HINTS.map(([keys, meaning]) => (
          <Fragment key={keys}>
            <dt>{keys}</dt>
            <dd>{meaning}</dd>
          </Fragment>
        ))}
      </dl>

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
    </div>
  );
}
