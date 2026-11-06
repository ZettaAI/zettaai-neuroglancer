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

/**
 * @file The trace's state where the proofreader is actually looking: a banner
 * over the viewer panels. The Trace tab's status line says the same, but a
 * first-time user never reads it and cannot tell a queue that is loading from
 * one that has run dry.
 */

import { SCORE_DIGITS } from "#src/datasource/calcada/candidate_ranking.js";
import { KeyChips } from "#src/datasource/calcada/react/key_chips.js";
import type { TraceEndPromptView } from "#src/datasource/calcada/trace_end_controller.js";
import { traceChords } from "#src/datasource/calcada/trace_key_bindings.js";
import { useSignalRerender } from "#src/editing/ui/interop/react/use_signal_rerender.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { NullarySignal } from "#src/util/signal.js";
import { Button } from "@/components/ui/button";

export interface TraceNotice {
  kind: "loading" | "candidate" | "empty" | "error";
  title: string;
  details?: readonly string[];
  /** The detail right under the title, in bold when it is good news. */
  headline?: { text: string; bold: boolean };
}

export interface TraceEndActions {
  certain(): void;
  uncertain(): void;
  deeper(): void;
  back(): void;
}

export interface TraceNoticeSource {
  readonly active: WatchableValueInterface<boolean>;
  readonly seedRoot: WatchableValueInterface<bigint | undefined>;
  readonly session: {
    readonly changed: NullarySignal;
    readonly notice: TraceNotice | undefined;
    readonly endPrompt?: TraceEndPromptView;
    readonly endActions?: TraceEndActions;
  };
}

export function CalcadaTraceNotice({ source }: { source: TraceNoticeSource }) {
  useSignalRerender(source.session.changed);

  const { notice, endPrompt, endActions } = source.session;
  if (endPrompt !== undefined && endActions !== undefined) {
    return <TraceEndPrompt prompt={endPrompt} actions={endActions} />;
  }
  if (notice === undefined) return null;
  return (
    <div
      className={`calcada-trace-notice calcada-trace-notice-${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <div className="calcada-trace-notice-title">
        <span className="calcada-trace-notice-mode">Trace</span>
        {notice.kind === "loading" && (
          <span className="calcada-trace-notice-spinner" aria-hidden />
        )}
        {notice.title}
      </div>
      {notice.headline !== undefined && (
        <div
          className={
            notice.headline.bold
              ? "calcada-trace-notice-detail calcada-trace-notice-highlight"
              : "calcada-trace-notice-detail"
          }
        >
          {notice.headline.text}
        </div>
      )}
      {notice.details?.map((detail) => (
        <div key={detail} className="calcada-trace-notice-detail">
          {detail}
        </div>
      ))}
    </div>
  );
}

function TraceEndPrompt({
  prompt,
  actions,
}: {
  prompt: TraceEndPromptView;
  actions: TraceEndActions;
}) {
  const checking = prompt.phase === "checking";
  return (
    <div
      className="calcada-trace-notice calcada-trace-notice-prompt"
      role="status"
    >
      <div className="calcada-trace-notice-title">
        <span className="calcada-trace-notice-mode">Trace</span>
        {checking && (
          <span className="calcada-trace-notice-spinner" aria-hidden />
        )}
        {checking
          ? "Checking…"
          : `No candidate passes the filters within ${Math.round(prompt.radiusNm)} nm`}
      </div>
      {!checking && (
        <>
          <div className="calcada-trace-notice-detail calcada-trace-notice-highlight">
            Score ≥ {prompt.threshold.toFixed(SCORE_DIGITS)}
          </div>
          <div className="calcada-trace-notice-buttons">
            <PromptButton
              label="Certain end"
              action="accept-candidate"
              onClick={actions.certain}
            />
            <PromptButton
              label="Uncertain end"
              action="reject-candidate"
              onClick={actions.uncertain}
            />
            <PromptButton
              label="Look deeper"
              action="skip-candidate"
              disabled={!prompt.canGoDeeper}
              onClick={actions.deeper}
            />
            <PromptButton
              label="Back"
              action="trace-end-back"
              disabled={!prompt.canGoBack}
              onClick={actions.back}
            />
          </div>
        </>
      )}
    </div>
  );
}

function PromptButton({
  label,
  action,
  disabled,
  onClick,
}: {
  label: string;
  action: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="xs" variant="outline" disabled={disabled} onClick={onClick}>
      {label}
      <KeyChips keys={traceChords(action)} />
    </Button>
  );
}
