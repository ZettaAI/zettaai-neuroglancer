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

import { CalcadaTimestampPicker } from "#src/datasource/calcada/react/timestamp_picker.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type {
  VersionHistoryStatus,
  VersionMoments,
} from "#src/layer/version_time_control.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { VersionMomentList } from "#src/widget/react/version_moment_list.js";

export const VERSION_TIME_SECTION_TITLE = "Bucket history";

export const VERSION_TIME_LIVE_NOTE =
  "Showing current data (editable). Pick a time to view the bucket as it was then; the bucket needs object versioning.";

export const VERSION_TIME_PAST_NOTE =
  "Viewing past data: read-only, editing is off. Clear the time to return to current, editable data.";

export const VERSION_TIME_CHECKING_NOTE = "Checking this bucket's history…";

export const VERSION_TIME_NO_PERMISSION_NOTE =
  "History unavailable: no permission to list this bucket's file versions. Ask for list access (storage.objects.list on GCS, s3:ListBucketVersions on S3).";

export const VERSION_TIME_NONE_FOUND_NOTE =
  "No earlier versions found for this layer: the bucket may not have object versioning, or nothing was rewritten yet. A chosen time may show current data.";

function noteFor(
  status: VersionHistoryStatus,
  timeChosen: boolean,
): { text: string; warning: boolean } {
  if (status === "no-permission") {
    return { text: VERSION_TIME_NO_PERMISSION_NOTE, warning: true };
  }
  if (status === "none-found") {
    return { text: VERSION_TIME_NONE_FOUND_NOTE, warning: true };
  }
  if (status === "checking" && !timeChosen) {
    return { text: VERSION_TIME_CHECKING_NOTE, warning: false };
  }
  return {
    text: timeChosen ? VERSION_TIME_PAST_NOTE : VERSION_TIME_LIVE_NOTE,
    warning: false,
  };
}

/**
 * "Bucket history" block of the Source tab, shown under the URL of a
 * precomputed data source in a GCS/S3 bucket. It sits next to the URL because
 * choosing a time rewrites that URL (adds `|versioned:@<time>/`), and clearing
 * the time restores the plain URL.
 */
export function VersionTimeSection({
  intermediateTimestamp,
  timestampLimit,
  historyStatus,
  versionMoments,
  chooseTime,
  searchMoreChanges,
  startTyping,
  applyTypedTime,
  finishTyping,
}: {
  intermediateTimestamp: WatchableValueInterface<number | undefined>;
  timestampLimit: WatchableValueInterface<number>;
  historyStatus: WatchableValueInterface<VersionHistoryStatus>;
  versionMoments: WatchableValueInterface<VersionMoments>;
  /** Show the layer at a time from the version list (`undefined` = latest). */
  chooseTime: (time: number | undefined) => void;
  /** Look through more of a large layer's files for older changes. */
  searchMoreChanges: () => void;
  /** The time-of-day field got focus. */
  startTyping: () => void;
  /** Enter in the time-of-day field. */
  applyTypedTime: () => void;
  /** Focus left the time-of-day field. */
  finishTyping: () => void;
}) {
  const timestamp = useWatchable(intermediateTimestamp);
  const status = useWatchable(historyStatus);
  const timeChosen = timestamp !== undefined;
  // Without list access no past time can be read; keep the picker only so a
  // time already in the URL (e.g. from a shared link) can be cleared.
  const showPicker = status !== "no-permission" || timeChosen;
  const note = noteFor(status, timeChosen);
  const isTimeField = (target: EventTarget) =>
    target instanceof HTMLInputElement && target.type === "time";
  return (
    <section
      aria-label={VERSION_TIME_SECTION_TITLE}
      className="neuroglancer-version-time-section my-2 flex flex-col gap-1.5 border-t border-border pt-2"
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {VERSION_TIME_SECTION_TITLE}
      </div>
      {status !== "no-permission" && (
        <VersionMomentList
          versionMoments={versionMoments}
          intermediateTimestamp={intermediateTimestamp}
          chooseTime={chooseTime}
          searchMoreChanges={searchMoreChanges}
        />
      )}
      {showPicker && (
        <div
          className="flex items-center gap-2"
          onFocus={(event) => {
            if (isTimeField(event.target)) startTyping();
          }}
          onBlur={(event) => {
            if (isTimeField(event.target)) finishTyping();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isTimeField(event.target)) {
              applyTypedTime();
            }
          }}
        >
          <span className="shrink-0 text-sm">Time</span>
          <CalcadaTimestampPicker
            intermediateTimestamp={intermediateTimestamp}
            timestampLimit={timestampLimit}
          />
        </div>
      )}
      <div
        role={note.warning ? "status" : undefined}
        className={
          note.warning
            ? "text-xs text-(--nge-warning-fg)"
            : "text-xs text-muted-foreground"
        }
      >
        {note.text}
      </div>
    </section>
  );
}
