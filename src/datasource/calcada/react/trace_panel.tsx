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

import { Fragment, useEffect, useReducer } from "react";

import type { SemanticClass } from "#src/datasource/calcada/candidate_heat.js";
import type { CalcadaOverviewState } from "#src/datasource/calcada/candidate_overview_state.js";
import { SEMANTIC_CLASSES } from "#src/datasource/calcada/candidate_overview_state.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import type {
  TraceScope,
  ZettaTraceState,
} from "#src/datasource/calcada/trace_state.js";
import {
  TRACE_CURRENT_USER,
  TRACE_SPHERE_RADIUS_MAX_NM,
  TRACE_SPHERE_RADIUS_MIN_NM,
} from "#src/datasource/calcada/trace_state.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { NullarySignal } from "#src/util/signal.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  readonly state: {
    readonly zettaTraceState: ZettaTraceState;
    readonly overviewState: CalcadaOverviewState;
  };
  readonly overviewSession: {
    readonly changed: NullarySignal;
    readonly status: string;
    apply(): void;
  };
  readonly traceSession: {
    readonly changed: NullarySignal;
    readonly status: string;
    readonly current: EdgeCandidate | undefined;
    readonly isBusy: boolean;
    reject(): void;
    skip(): void;
    goToSeed(): void;
    clearSeed(): void;
    accept(): Promise<void>;
    undoLast(): Promise<void>;
  };
  canUndo(): boolean;
}

/**
 * The trace session reports through a bare signal rather than a watchable: its
 * status, candidate and busy flag are plain fields that change together. A
 * snapshot of them would have to be rebuilt on every read for
 * `useSyncExternalStore`, which cannot cache it, so the signal drives a
 * re-render and the fields are read during it.
 */
function useSignalRerender(signal: NullarySignal) {
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    const unsubscribe = signal.add(rerender);
    return () => {
      unsubscribe();
    };
  }, [signal, rerender]);
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
];

type RejectedByMode = "anyone" | "me" | "custom";

const REJECTED_BY_LABELS: ReadonlyArray<[RejectedByMode, string]> = [
  ["anyone", "anyone"],
  ["me", "only me"],
  ["custom", "me and…"],
];

function rejectedByMode(rejectedBy: readonly string[]): RejectedByMode {
  if (rejectedBy.length === 0) return "anyone";
  return rejectedBy.some((user) => user !== TRACE_CURRENT_USER)
    ? "custom"
    : "me";
}

function otherUsers(rejectedBy: readonly string[]): string[] {
  return rejectedBy.filter((user) => user !== TRACE_CURRENT_USER);
}

function clampRadius(radiusNm: number): number {
  return Math.min(
    TRACE_SPHERE_RADIUS_MAX_NM,
    Math.max(TRACE_SPHERE_RADIUS_MIN_NM, radiusNm),
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
  const radiusNm = useWatchable(traceState.sphereRadiusNm);
  const seedCenter = useWatchable(traceState.sphereCenter);
  const minPieceVoxels = useWatchable(traceState.minPieceVoxels);
  const rejectedBy = useWatchable(traceState.rejectedBy);
  const overviewActive = useWatchable(overviewState.active);
  const overviewClass = useWatchable(overviewState.semanticClass);
  const overviewMinScore = useWatchable(overviewState.minScore);
  const overviewMinFraction = useWatchable(overviewState.minClassFraction);

  const mode = rejectedByMode(rejectedBy);
  const busy = traceSession.isBusy;
  const verdictDisabled = busy || traceSession.current === undefined;

  const setRejectedBy = (nextMode: RejectedByMode, users: string[]) => {
    traceState.rejectedBy.value =
      nextMode === "anyone" ? [] : [TRACE_CURRENT_USER, ...users];
  };

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
        <div className="calcada-trace-panel-row">
          Seed at{" "}
          {Array.from(seedCenter)
            .map((value) => Math.round(value))
            .join(", ")}
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
        <Input
          type="number"
          min={TRACE_SPHERE_RADIUS_MIN_NM}
          max={TRACE_SPHERE_RADIUS_MAX_NM}
          step={100}
          title="Radius of the sphere. Changing it after the seed is placed re-picks the candidates."
          disabled={scope === "segment"}
          value={Math.round(radiusNm)}
          onChange={(event) => {
            const parsed = Number.parseFloat(event.target.value);
            if (!Number.isFinite(parsed)) return;
            traceState.sphereRadiusNm.value = clampRadius(parsed);
          }}
        />
      </label>

      <label className="calcada-trace-panel-row">
        Min candidate size
        <Input
          type="number"
          min={0}
          step={100}
          title="Skip candidates whose piece is smaller than this many voxels"
          value={minPieceVoxels}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            traceState.minPieceVoxels.value =
              Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          }}
        />
      </label>

      {/* Proofreaders disagree, so whose rejections count is a setting rather
          than a rule. "me" is sent verbatim — the server resolves it, because
          the browser holds an opaque token and has no idea whose it is. */}
      <label className="calcada-trace-panel-row">
        Skip rejected by
        <Select
          value={mode}
          onValueChange={(next) =>
            setRejectedBy(next as RejectedByMode, otherUsers(rejectedBy))
          }
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REJECTED_BY_LABELS.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {mode === "custom" && (
        <Input
          type="text"
          placeholder="tommy@zetta.ai, …"
          title="Comma-separated users whose rejections to skip as well"
          defaultValue={otherUsers(rejectedBy).join(", ")}
          onBlur={(event) =>
            setRejectedBy(
              "custom",
              event.target.value
                .split(",")
                .map((user) => user.trim())
                .filter((user) => user.length > 0),
            )
          }
        />
      )}

      <fieldset className="calcada-trace-panel-overview">
        <legend>
          <label>
            <input
              type="checkbox"
              checked={overviewActive}
              onChange={(event) => {
                overviewState.active.value = event.target.checked;
              }}
            />
            Candidate overview
          </label>
        </legend>

        {overviewActive && (
          <>
            <div className="calcada-trace-panel-legend">
              <span className="calcada-trace-panel-legend-scale" />
              <span>no candidates</span>
              <span>strong</span>
            </div>

            <label className="calcada-trace-panel-row">
              Min score
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={overviewMinScore}
                onChange={(event) => {
                  const parsed = Number.parseFloat(event.target.value);
                  if (Number.isFinite(parsed)) {
                    overviewState.minScore.value = parsed;
                  }
                }}
              />
            </label>

            <label className="calcada-trace-panel-row">
              Only pieces that are
              <Select
                value={overviewClass}
                onValueChange={(next) => {
                  overviewState.semanticClass.value = next as SemanticClass;
                }}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEMANTIC_CLASSES.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            {overviewClass !== "any" && (
              <label className="calcada-trace-panel-row">
                at least, %
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(overviewMinFraction * 100)}
                  onChange={(event) => {
                    const parsed = Number.parseFloat(event.target.value);
                    if (Number.isFinite(parsed)) {
                      overviewState.minClassFraction.value = parsed / 100;
                    }
                  }}
                />
              </label>
            )}

            <div className="calcada-trace-panel-buttons">
              <Button
                size="xs"
                title="Load and colour the candidates matching these filters"
                onClick={() => connection.overviewSession.apply()}
              >
                Apply
              </Button>
            </div>

            <div className="calcada-trace-panel-status">
              {connection.overviewSession.status ||
                "Set the filters, then Apply"}
            </div>
          </>
        )}
      </fieldset>

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
          disabled={busy || !connection.canUndo()}
          title="Take back the last edit (⌘/ctrl+Z)"
          onClick={() => void traceSession.undoLast()}
        >
          Undo
        </Button>
      </div>
    </div>
  );
}
