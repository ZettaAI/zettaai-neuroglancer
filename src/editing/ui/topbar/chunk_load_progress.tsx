/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/topbar/editing_topbar.css";

import { Loader2, TriangleAlert } from "lucide-preact";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";

/**
 * Topbar indicator for the background bbox-chunk preload (TM-316).
 *
 * - while `loading`: `chunks N/M` + a progress bar (painting is already usable);
 * - on a clean `done` (every chunk loaded): nothing — that is the expected
 *   outcome, so we avoid a transient "loaded" badge that would pop in and then
 *   out (per the "nothing moves unless necessary" UX principle);
 * - on `done` with failed or skipped chunks: one warning naming both counts,
 *   with per-(layer, resolution) failure detail — painting still works (those
 *   chunks load on demand on first read).
 */
export function ChunkLoadProgress({ host }: { host: EditSessionHost }) {
  const progress = useWatchable(host.chunkLoadProgress);

  if (progress.kind === "idle") return null;

  if (progress.kind === "loading") {
    const { loaded, total } = progress;
    const pct =
      total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    return (
      <div
        class="neuroglancer-editing-topbar-group neuroglancer-editing-topbar-chunkload"
        role="status"
        aria-label={`Loading edit region: ${loaded} of ${total} chunks`}
        data-tooltip="Preloading the edit region — painting is available now"
      >
        <Loader2
          size={13}
          class="neuroglancer-editing-topbar-spinner"
          aria-hidden="true"
        />
        <span class="neuroglancer-editing-topbar-chunkload-label">
          chunks {loaded}/{total}
        </span>
        <span
          class="neuroglancer-editing-topbar-chunkload-bar"
          aria-hidden="true"
        >
          <span
            class="neuroglancer-editing-topbar-chunkload-fill"
            style={{ width: `${pct}%` }}
          />
        </span>
      </div>
    );
  }

  // progress.kind === "done"
  const labels: string[] = [];
  const tooltips: string[] = [];
  if (progress.failed > 0) {
    const label = `${progress.failed} ${chunkNoun(progress.failed)} unavailable`;
    labels.push(label);
    tooltips.push(
      `${label} — they will load on demand while painting`,
      ...progress.failures.map(
        (failure) =>
          `${failure.layerId} @ ${failure.resolution}: ${failure.count}`,
      ),
    );
  }
  if (progress.skipped !== undefined) {
    labels.push(
      `${progress.skipped} ${chunkNoun(progress.skipped)} not preloaded`,
    );
    tooltips.push(
      `The edit region is larger than the viewer's memory budget: ${progress.skipped} of ${progress.total} chunks were not preloaded and load on demand while painting`,
    );
  }

  // Clean `done`: render nothing — no transient confirmation badge.
  if (labels.length === 0) return null;
  return (
    <ChunkLoadWarning
      label={labels.join(" · ")}
      tooltip={tooltips.join("\n")}
    />
  );
}

function chunkNoun(count: number): string {
  return count === 1 ? "chunk" : "chunks";
}

/** The topbar's warning badge for a preload that ended short of every chunk. */
function ChunkLoadWarning({
  label,
  tooltip,
}: {
  label: string;
  tooltip: string;
}) {
  return (
    <div
      class="neuroglancer-editing-topbar-group neuroglancer-editing-topbar-chunkload warning"
      role="status"
      aria-label={label}
      data-tooltip={tooltip}
    >
      <TriangleAlert size={13} aria-hidden="true" />
      <span class="neuroglancer-editing-topbar-chunkload-label">{label}</span>
    </div>
  );
}
