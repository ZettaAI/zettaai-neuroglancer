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

import { useSignalRerender } from "#src/datasource/calcada/react/trace_panel.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { NullarySignal } from "#src/util/signal.js";

export interface TraceNotice {
  kind: "loading" | "candidate" | "empty" | "error";
  title: string;
  details?: readonly string[];
}

export interface TraceNoticeSource {
  readonly active: WatchableValueInterface<boolean>;
  readonly sphereCenter: WatchableValueInterface<Float32Array | undefined>;
  readonly session: {
    readonly changed: NullarySignal;
    readonly notice: TraceNotice | undefined;
  };
}

export function CalcadaTraceNotice({ source }: { source: TraceNoticeSource }) {
  useSignalRerender(source.session.changed);

  const { notice } = source.session;
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
      {notice.details?.map((detail) => (
        <div key={detail} className="calcada-trace-notice-detail">
          {detail}
        </div>
      ))}
    </div>
  );
}
