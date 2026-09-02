/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  CalcadaGraphSource,
  CalcadaLabeledTimestamp,
} from "#src/datasource/calcada/frontend.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { ListboxOption } from "#src/widget/listbox_dropdown.js";
import { ListboxDropdown } from "#src/widget/listbox_dropdown.js";

export const LABELED_TIMESTAMP_CONTROL_TITLE =
  "Labeled timestamps for the current branch. Selecting one switches the view to that point in time (read-only).";

const LIVE_VALUE = "";

// Stand-in for layers whose graph isn't a CalcadaGraphSource: the control
// still renders (with only "— live —") so the layer-control row keeps its
// shape.
const NO_LABELS = new WatchableValue<CalcadaLabeledTimestamp[]>([]);

function labelOptions(
  labels: readonly CalcadaLabeledTimestamp[],
): ListboxOption[] {
  return [
    { key: LIVE_VALUE, label: "— live —" },
    ...labels.map((entry) => ({
      key: String(entry.timestampMs),
      label:
        entry.visibility === "admin" ? `${entry.label} (admins)` : entry.label,
    })),
  ];
}

/**
 * The Calcada "Label" layer control: switches the view to a labeled
 * timestamp (read-only) or back to "— live —". Not filterable — label lists
 * are short compared to branch lists, so a search box would be pure
 * overhead.
 */
export function CalcadaLabeledTimestampPicker({
  graph,
  intermediateTimestamp,
}: {
  graph: CalcadaGraphSource | undefined;
  intermediateTimestamp: WatchableValueInterface<number | undefined>;
}) {
  const labels = useWatchable(graph?.labeledTimestamps ?? NO_LABELS);
  const currentTimestamp = useWatchable(intermediateTimestamp);
  const options = labelOptions(labels);
  // Reflect the PENDING value: on a rejected switch the guard snaps
  // intermediateTimestamp back to the committed timestamp, which re-renders
  // this to match reality.
  const match = labels.find((entry) => entry.timestampMs === currentTimestamp);
  const value = match ? String(match.timestampMs) : LIVE_VALUE;

  const onChange = (key: string) => {
    intermediateTimestamp.value =
      key === LIVE_VALUE ? undefined : Number.parseInt(key, 10);
  };

  return (
    <span
      class="neuroglancer-calcada-labeled-timestamp-select"
      title={LABELED_TIMESTAMP_CONTROL_TITLE}
    >
      <ListboxDropdown
        options={options}
        value={value}
        onChange={onChange}
        onOpen={() => graph?.triggerLabeledTimestampRefresh()}
        ariaLabel="Label"
      />
    </span>
  );
}
