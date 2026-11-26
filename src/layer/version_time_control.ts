/**
 * @license
 * Copyright 2026 Zetta AI.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * "Version history" time picker for layers whose data source reads a bucket
 * with object versioning through the `versioned:` kvstore adapter. Same picker
 * and behaviour as the Calcada/graphene time control: pick a time to view the
 * data as it was then, clear to return to current data.
 *
 * The chosen time is layer state of its own (`UserLayer.versionTime`, saved
 * in the layer JSON and share links), not part of the data source URL: like
 * the Calcada timestamp, switching versions keeps the data source loaded and
 * only re-requests the layer's chunks. The picker is shown in the Source tab
 * right under the URL, once per layer, for any layer type.
 */

import "#src/datasource/calcada/calcada.css";
import { isSessionLayer } from "#src/editing/adapters/session_layer_structure_lock.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import {
  canChooseVersionTime,
  versionedKvStoreUrlOf,
} from "#src/kvstore/versioned/url.js";
import { VersionedKvStore } from "#src/kvstore/versioned/versioned_kvstore.js";
import type { UserLayer } from "#src/layer/index.js";
import type { LayerDataSource } from "#src/layer/layer_data_source.js";
import { StatusMessage } from "#src/status.js";
import { CachedWatchableValue, WatchableValue } from "#src/trackable_value.js";
import type { RefCounted } from "#src/util/disposable.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { VersionTimeSection } from "#src/widget/react/version_time_section.js";

/**
 * Data sources a time can be chosen for: those already read through
 * `versioned:`, and precomputed sources in a GCS/S3 bucket.
 */
function versionedDataSources(layer: UserLayer): LayerDataSource[] {
  return layer.dataSources.filter((dataSource) =>
    canChooseVersionTime(dataSource.spec.url),
  );
}

/** Time the layer is viewed at (`undefined` = latest data). */
export function getLayerVersionTime(layer: UserLayer): number | undefined {
  return layer.versionTime.value;
}

/**
 * Views the layer at `time` (`undefined` = latest data). The data sources
 * stay loaded; only the layer's chunks are requested again.
 */
export function setLayerVersionTime(
  layer: UserLayer,
  time: number | undefined,
): void {
  layer.versionTime.value = time;
}

/** The data source whose Source-tab view hosts the layer's time picker. */
export function firstVersionedDataSource(
  layer: UserLayer,
): LayerDataSource | undefined {
  return versionedDataSources(layer)[0];
}

/**
 * True while `dataSource` is the layer's first `versioned:` source. Signals
 * only when that answer flips: the section is rebuilt on every signal, so
 * signalling on every data source change would remount the picker (and drop
 * keyboard focus) whenever a data source changes.
 */
export function watchHostsVersionTime(
  dataSource: LayerDataSource,
): CachedWatchableValue<boolean> {
  const { layer } = dataSource;
  return new CachedWatchableValue<boolean>({
    get value() {
      return firstVersionedDataSource(layer) === dataSource;
    },
    changed: layer.dataSourcesChanged,
  });
}

/**
 * The picker commits every keystroke and clamps it to its lower limit, so a
 * limit inside a day would snap a half-typed time (hour "1" of "15:30") to
 * the limit. The limit is therefore the start of the day the layer appeared:
 * the calendar still blocks earlier days, and typing a time stays free.
 */
export function startOfLocalDay(time: number): number {
  if (time === 0) return 0;
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.valueOf();
}

/** `versioned:` kvstore (no time) of the first such source, or `undefined`. */
function earliestTimeSourceOf(layer: UserLayer): string | undefined {
  const [dataSource] = versionedDataSources(layer);
  return dataSource === undefined
    ? undefined
    : versionedKvStoreUrlOf(dataSource.spec.url);
}

/**
 * What the layer's bucket can show for past times. `"checking"` until known;
 * `"unknown"` when the check failed for another reason (the picker then
 * works as usual and reading reports any error).
 */
export type VersionHistoryStatus =
  | "checking"
  | "available"
  | "no-permission"
  | "unknown";

function layerVersionedStore(layer: UserLayer): VersionedKvStore | undefined {
  const kvStoreUrl = earliestTimeSourceOf(layer);
  if (kvStoreUrl === undefined) return undefined;
  const { kvStoreContext } =
    layer.manager.dataSourceProviderRegistry.sharedKvStoreContext;
  try {
    const { store } = kvStoreContext.getKvStore(kvStoreUrl);
    return store instanceof VersionedKvStore ? store : undefined;
  } catch {
    // An unusable URL is reported by the data source itself; the history
    // block just shows the picker.
    return undefined;
  }
}

/**
 * Whether the bucket lets us list versions, and the earliest time the
 * layer's `info` file existed (so the picker cannot select a time before the
 * layer had any data; `0` = no limit). One version listing of `info` only:
 * the layer's other objects are never listed up front, since a large layer
 * can hold millions of them.
 */
async function getLayerHistory(
  store: VersionedKvStore,
): Promise<{ status: VersionHistoryStatus; earliestTime: number }> {
  const earliest = await store.earliestVersionTime("info", {});
  if (earliest === "no-permission") {
    return { status: "no-permission", earliestTime: 0 };
  }
  if (earliest === undefined) return { status: "unknown", earliestTime: 0 };
  return { status: "available", earliestTime: earliest };
}

/**
 * State behind the "Version history" time picker.
 *
 * The picker writes every change into `intermediateTimestamp` (a draft). A
 * draft is applied to the layer right away when it comes from the calendar or
 * the clear button, but not while the time field is being typed in: each
 * applied time re-requests the layer's chunks, so applying every keystroke
 * would load data for each half-typed value (e.g. hour "0" of "01:…"). Typing is applied by
 * `applyDraft()` on Enter or when the field loses focus.
 */
export function makeVersionTimeState(layer: UserLayer, context: RefCounted) {
  const intermediateTimestamp = new WatchableValue<number | undefined>(
    getLayerVersionTime(layer),
  );
  // Picker lower limit: start of the day the layer appeared (the picker
  // clamps each keystroke to it, see `startOfLocalDay`).
  const timestampLimit = new WatchableValue<number>(0);
  const historyStatus = new WatchableValue<VersionHistoryStatus>("checking");
  // Exact time the layer appeared; an applied time is clamped to it.
  let earliestTime = 0;
  let typing = false;

  // The lower limit depends on which layer is read, not on the chosen time.
  let earliestTimeSource: string | undefined;
  const updateEarliestTime = () => {
    const source = earliestTimeSourceOf(layer);
    if (source === earliestTimeSource) return;
    earliestTimeSource = source;
    earliestTime = 0;
    timestampLimit.value = 0;
    const store = layerVersionedStore(layer);
    if (store === undefined) {
      // Nothing can be listed: no request to wait for.
      historyStatus.value = "unknown";
      return;
    }
    historyStatus.value = "checking";
    const isCurrent = () =>
      !context.wasDisposed && earliestTimeSource === source;
    getLayerHistory(store).then(
      (history) => {
        if (!isCurrent()) return;
        historyStatus.value = history.status;
        earliestTime = history.earliestTime;
        timestampLimit.value = startOfLocalDay(history.earliestTime);
      },
      () => {
        // Errors reading the layer are reported by the data source; the
        // picker just stays without a lower limit.
        if (isCurrent()) historyStatus.value = "unknown";
      },
    );
  };
  updateEarliestTime();

  const showLayerTime = () => {
    const time = getLayerVersionTime(layer);
    if (intermediateTimestamp.value !== time) {
      intermediateTimestamp.value = time;
    }
  };

  const applyDraft = () => {
    let time = intermediateTimestamp.value;
    if (time !== undefined && time < earliestTime) {
      // Before the layer existed nothing can be shown: show its first version.
      time = earliestTime;
      StatusMessage.showTemporaryMessage(
        `This layer has data only from ${new Date(earliestTime).toLocaleString()}; showing that time.`,
        5000,
      );
    }
    if (time === getLayerVersionTime(layer)) {
      showLayerTime();
      return;
    }
    // Second line of defence: `blockedSchemeOf` already keeps layers viewed
    // at a past time out of edit sessions, but a session layer must never
    // switch to past data underneath the session.
    if (isSessionLayer(layer.managedLayer)) {
      showLayerTime();
      StatusMessage.showTemporaryMessage(
        "Cannot change time: layer is locked by the active edit session.",
        4000,
      );
      return;
    }
    setLayerVersionTime(layer, time);
    showLayerTime();
  };

  context.registerDisposer(
    layer.dataSourcesChanged.add(() => {
      updateEarliestTime();
      // Keep a half-typed draft; it is applied or dropped when typing ends.
      if (!typing) showLayerTime();
    }),
  );
  context.registerDisposer(
    layer.versionTime.changed.add(() => {
      if (!typing) showLayerTime();
    }),
  );
  context.registerDisposer(
    intermediateTimestamp.changed.add(() => {
      if (!typing) applyDraft();
    }),
  );
  return {
    intermediateTimestamp,
    timestampLimit,
    historyStatus,
    /** The time field got focus: hold typed changes until applied. */
    startTyping: () => {
      typing = true;
    },
    /** Enter in the time field: apply the typed time; the field keeps focus. */
    applyTypedTime: applyDraft,
    /** The time field lost focus: apply the typed time and stop holding. */
    finishTyping: () => {
      typing = false;
      applyDraft();
    },
  };
}

/**
 * The "Version history" block of the Source tab for `dataSource`: shown under
 * its URL while it is the layer's first `versioned:` source, empty otherwise.
 * One picker per layer, since the time applies to all its versioned sources.
 */
export function makeVersionTimeSourceSection(
  dataSource: LayerDataSource,
): DependentViewWidget<boolean> {
  const hostsVersionTime = watchHostsVersionTime(dataSource);
  const widget = new DependentViewWidget(
    hostsVersionTime,
    (hosts, parent, context) => {
      if (!hosts) return;
      const element = document.createElement("div");
      context.registerDisposer(
        mountComponent(
          element,
          VersionTimeSection,
          makeVersionTimeState(dataSource.layer, context),
        ),
      );
      parent.appendChild(element);
    },
  );
  widget.registerDisposer(hostsVersionTime);
  return widget;
}
