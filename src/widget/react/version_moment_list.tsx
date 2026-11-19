/** @jsxImportSource react */
/**
 * @license
 * Copyright 2026 Zetta AI.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { format } from "date-fns";
import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";

import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import { neighbourMoment } from "#src/kvstore/versioned/change_moments.js";
import type { VersionMoments } from "#src/layer/version_time_control.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const LATEST_VERSION_LABEL = "Latest";
export const OLDER_VERSION_LABEL = "Older version";
export const NEWER_VERSION_LABEL = "Newer version";
export const VERSION_LIST_LABEL = "Versions";
export const REFRESH_VERSIONS_LABEL = "Look for new versions";
export const SEARCH_MORE_LABEL = "Search more files";
export const PARTIAL_LIST_NOTE =
  "Large layer: only changes found so far are listed.";
export const SEARCHING_NOTE = "Looking for changes…";

export function formatMoment(time: number) {
  return format(new Date(time), "d MMM yyyy, HH:mm:ss");
}

/**
 * The layer's versions (moments it changed), newest first, with ◀ ▶ to step
 * between them, so a time does not have to be guessed.
 */
export function VersionMomentList({
  versionMoments,
  intermediateTimestamp,
  chooseTime,
  searchMoreChanges,
  refreshChanges,
}: {
  versionMoments: WatchableValueInterface<VersionMoments>;
  intermediateTimestamp: WatchableValueInterface<number | undefined>;
  chooseTime: (time: number | undefined) => void;
  searchMoreChanges: () => void;
  /** `force`: re-read now, not only if the list is a few seconds old. */
  refreshChanges: (force?: boolean) => void;
}) {
  const { moments, latestChange, complete, loading } =
    useWatchable(versionMoments);
  const current = useWatchable(intermediateTimestamp);
  const older = neighbourMoment(moments, current, "older");
  const newer = neighbourMoment(moments, current, "newer");
  const rows: { time: number | undefined; label: string }[] = [
    {
      time: undefined,
      label:
        latestChange === undefined
          ? LATEST_VERSION_LABEL
          : `${LATEST_VERSION_LABEL} · ${formatMoment(latestChange)}`,
    },
    ...moments.map((time) => ({ time, label: formatMoment(time) })),
  ];
  return (
    // New saves happen while the block is open: re-read the list (at most
    // every few seconds) when the pointer comes to it.
    <div
      className="flex flex-col gap-1"
      onPointerEnter={() => refreshChanges()}
    >
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={OLDER_VERSION_LABEL}
          title={OLDER_VERSION_LABEL}
          disabled={older === null}
          onClick={() => {
            if (older !== null) chooseTime(older);
          }}
        >
          <ChevronLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-center text-sm">
          {current === undefined ? rows[0].label : formatMoment(current)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={NEWER_VERSION_LABEL}
          title={NEWER_VERSION_LABEL}
          disabled={newer === null}
          onClick={() => {
            if (newer !== null) chooseTime(newer);
          }}
        >
          <ChevronRightIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={REFRESH_VERSIONS_LABEL}
          title={REFRESH_VERSIONS_LABEL}
          onClick={() => refreshChanges(true)}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <div
        role="listbox"
        aria-label={VERSION_LIST_LABEL}
        className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-border"
      >
        {rows.map(({ time, label }) => {
          const selected = time === current;
          return (
            <button
              key={time ?? "latest"}
              type="button"
              role="option"
              aria-selected={selected}
              className={cn(
                "px-2 py-1 text-left text-sm hover:bg-muted",
                selected && "bg-muted font-medium",
              )}
              onClick={() => chooseTime(time)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {(loading || !complete) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex-1">
            {loading ? SEARCHING_NOTE : PARTIAL_LIST_NOTE}
          </span>
          {!loading && (
            <Button variant="outline" size="xs" onClick={searchMoreChanges}>
              {SEARCH_MORE_LABEL}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
