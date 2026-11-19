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
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import { neighbourMoment } from "#src/kvstore/versioned/change_moments.js";
import type { VersionMoments } from "#src/layer/version_time_control.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { ListboxOption } from "#src/widget/listbox_dropdown.js";
import { SearchableSelect } from "#src/widget/react/searchable_select.js";
import { Button } from "@/components/ui/button";

/** The current data, as Calcada's Label control names it. */
export const LATEST_VERSION_LABEL = "— live —";
export const OLDER_VERSION_LABEL = "Older version";
export const NEWER_VERSION_LABEL = "Newer version";
export const VERSION_LIST_LABEL = "Version";
export const SEARCH_MORE_LABEL = "Search more files";
export const PARTIAL_LIST_NOTE =
  "Large layer: only changes found so far are listed.";

const LATEST_KEY = "latest";

export function formatMoment(time: number) {
  return format(new Date(time), "d MMM yyyy, HH:mm:ss");
}

function versionOptions(
  { moments }: VersionMoments,
  current: number | undefined,
): ListboxOption[] {
  const options: ListboxOption[] = [
    { key: LATEST_KEY, label: LATEST_VERSION_LABEL },
    ...moments.map((time) => ({
      key: String(time),
      label: formatMoment(time),
    })),
  ];
  // A time typed by hand (or from a link) between versions still shows.
  if (current !== undefined && !moments.includes(current)) {
    options.push({ key: String(current), label: formatMoment(current) });
  }
  return options;
}

/**
 * The layer's versions (one per save), newest first, in a dropdown like the
 * Calcada "Label" control, with ◀ ▶ to step between them so a time does not
 * have to be guessed. Opening the dropdown re-reads the list, so saves made
 * since show up.
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
  /** Re-read the version list (saves made since it was read). */
  refreshChanges: () => void;
}) {
  const state = useWatchable(versionMoments);
  const { moments, complete, loading, read } = state;
  const current = useWatchable(intermediateTimestamp);
  const older = neighbourMoment(moments, current, "older");
  const newer = neighbourMoment(moments, current, "newer");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* The dropdown starts where the date above starts; ◀ ▶ sit at the
          end, where the clear button is above. */}
      <div className="flex items-center gap-1.5">
        <SearchableSelect
          className="min-w-0 flex-1"
          options={versionOptions(state, current)}
          value={current === undefined ? LATEST_KEY : String(current)}
          onChange={(key) =>
            chooseTime(
              key === LATEST_KEY ? undefined : Number.parseInt(key, 10),
            )
          }
          onOpen={refreshChanges}
          ariaLabel={VERSION_LIST_LABEL}
        />
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
      </div>
      {/* Only for a large layer, once known to be listed in part; it stays
          put while more is read so the block does not jump. */}
      {read && !complete && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex-1">{PARTIAL_LIST_NOTE}</span>
          <Button
            variant="outline"
            size="xs"
            disabled={loading}
            onClick={searchMoreChanges}
          >
            {SEARCH_MORE_LABEL}
          </Button>
        </div>
      )}
    </div>
  );
}
