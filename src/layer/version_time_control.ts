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
 * "Bucket history" time picker for layers whose data source reads a bucket
 * with object versioning through the `versioned:` kvstore adapter. Same picker
 * and behaviour as the Calcada/graphene time control: pick a time to view the
 * data as it was then, clear to return to current data.
 *
 * The chosen time lives in the data source URL (`|versioned:@<time>/`), so it
 * is saved in the layer state and share links, and the picker is shown in the
 * Source tab right under that URL, once per layer, for any layer type.
 */

import "#src/datasource/calcada/calcada.css";
import { isSessionLayer } from "#src/editing/adapters/session_layer_structure_lock.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { groupChangeMoments } from "#src/kvstore/versioned/change_moments.js";
import {
  canChooseVersionTime,
  chooseVersionTimeInUrl,
  getVersionTimeFromUrl,
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

/** Time chosen on the layer's versioned data sources (`undefined` = live). */
export function getLayerVersionTime(layer: UserLayer): number | undefined {
  for (const dataSource of versionedDataSources(layer)) {
    try {
      const time = getVersionTimeFromUrl(dataSource.spec.url);
      if (time !== undefined) return time;
    } catch {
      // An invalid time is reported by the data source itself.
    }
  }
  return undefined;
}

/**
 * Sets the time on every data source of the layer a time can be chosen for,
 * reloading each one whose URL changes. A time adds the `versioned:` adapter
 * (read-only past data); `undefined` removes it again, back to the plain,
 * editable URL.
 */
export function setLayerVersionTime(
  layer: UserLayer,
  time: number | undefined,
): void {
  for (const dataSource of versionedDataSources(layer)) {
    const existingSpec = dataSource.spec;
    const url = chooseVersionTimeInUrl(existingSpec.url, time);
    if (url === existingSpec.url) continue;
    // Not `setManually`: that makes NG rewrite the URL into its canonical
    // long form once loaded, which would turn the restored
    // `precomputed://bucket/layer` into `bucket/layer/|neuroglancer-precomputed:`.
    dataSource.spec = { ...existingSpec, url };
  }
}

/** The data source whose Source-tab view hosts the layer's time picker. */
export function firstVersionedDataSource(
  layer: UserLayer,
): LayerDataSource | undefined {
  return versionedDataSources(layer)[0];
}

/**
 * True while `dataSource` is the layer's first `versioned:` source. Signals
 * only when that answer flips: the section is rebuilt on every signal, and
 * choosing a time rewrites the data source URL, so signalling on every data
 * source change would remount the picker (and drop keyboard focus) after each
 * typed digit.
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
 * Earliest time the layer's `info` file existed, so the picker cannot select
 * a time before the layer had any data. `0` (no limit) when unknown.
 */
async function getEarliestLayerTime(layer: UserLayer): Promise<number> {
  const store = layerVersionedStore(layer);
  if (store === undefined) return 0;
  return (await store.earliestVersionTime("info", {})) ?? 0;
}

/**
 * What the layer's bucket can show for past times. `"checking"` until known;
 * `"unknown"` when the check failed for another reason (the picker then
 * works as usual and reading reports any error).
 */
export type VersionHistoryStatus =
  | "checking"
  | "available"
  | "none-found"
  | "no-permission"
  | "unknown";

/** Change moments of the layer found so far (see `groupChangeMoments`). */
export interface VersionMoments {
  /** Earlier versions to pick from, newest first; the latest data excluded. */
  moments: number[];
  /** When the latest data was written, once every object was listed. */
  latestChange: number | undefined;
  /** Every object under the layer was listed: `moments` is the full history. */
  complete: boolean;
  /** A listing page is being read. */
  loading: boolean;
}

const NO_MOMENTS: VersionMoments = {
  moments: [],
  latestChange: undefined,
  complete: false,
  loading: false,
};

/** Listing pages read per "Search more files" click (1000 versions each). */
export const MORE_CHANGES_PAGES = 5;

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
    // block just has nothing to list.
    return undefined;
  }
}

/**
 * Lists the layer's changes page by page and keeps `historyStatus` and
 * `versionMoments` up to date. The first page is the same single request
 * that tells whether the bucket has history, so the moments cost nothing
 * extra for layers up to 1000 stored versions.
 */
class LayerChangesListing {
  private changeTimes: number[] = [];
  private cursor: string | undefined;
  private hasEarlierVersion = false;
  private complete = false;
  private reading = false;
  /** Next read starts the listing over (`refresh`). */
  private restart = false;

  constructor(
    private store: VersionedKvStore | undefined,
    private isCurrent: () => boolean,
    private historyStatus: WatchableValue<VersionHistoryStatus>,
    private versionMoments: WatchableValue<VersionMoments>,
  ) {}

  /**
   * Reads the listing again from the start, to pick up changes saved since
   * (one request). The shown list stays until the new one arrives.
   */
  refresh() {
    if (this.reading || this.store === undefined) return;
    this.restart = true;
    void this.readPages(1, { quiet: true });
  }

  async readPages(pages: number, { quiet = false } = {}) {
    const { store } = this;
    if (store === undefined) {
      this.historyStatus.value = "unknown";
      return;
    }
    if (this.reading) return;
    this.reading = true;
    if (!quiet) this.publish(true);
    try {
      for (let page = 0; page < pages; ++page) {
        const result = await store.listChanges(
          this.restart ? undefined : this.cursor,
          {},
        );
        if (!this.isCurrent()) return;
        if (result === "no-permission") {
          this.historyStatus.value = "no-permission";
          return;
        }
        if (this.restart) {
          this.restart = false;
          this.changeTimes = [];
          this.hasEarlierVersion = false;
        }
        this.changeTimes.push(...result.changeTimes);
        this.hasEarlierVersion ||= result.hasEarlierVersion;
        this.cursor = result.nextCursor;
        this.complete = result.nextCursor === undefined;
        this.historyStatus.value = this.hasEarlierVersion
          ? "available"
          : "none-found";
        this.publish(!this.complete && page + 1 < pages);
        if (this.complete) break;
      }
    } catch {
      if (this.isCurrent() && this.historyStatus.value === "checking") {
        this.historyStatus.value = "unknown";
      }
    } finally {
      this.reading = false;
      if (this.isCurrent()) this.publish(false);
    }
  }

  private publish(loading: boolean) {
    const all = groupChangeMoments(this.changeTimes);
    // With every object listed the newest moment is the latest data itself.
    this.versionMoments.value = {
      moments: this.complete ? all.slice(1) : all,
      latestChange: this.complete ? all[0] : undefined,
      complete: this.complete,
      loading,
    };
  }
}

/**
 * State behind the "Bucket history" time picker.
 *
 * The picker writes every change into `intermediateTimestamp` (a draft). A
 * draft is applied to the layer right away when it comes from the calendar or
 * the clear button, but not while the time field is being typed in: each
 * applied time reloads the layer, so applying every keystroke would reload it
 * for each half-typed value (e.g. hour "0" of "01:…"). Typing is applied by
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
  const versionMoments = new WatchableValue<VersionMoments>(NO_MOMENTS);
  let changesListing: LayerChangesListing | undefined;
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
    historyStatus.value = "checking";
    versionMoments.value = NO_MOMENTS;
    changesListing = new LayerChangesListing(
      layerVersionedStore(layer),
      () => !context.wasDisposed && earliestTimeSource === source,
      historyStatus,
      versionMoments,
    );
    void changesListing.readPages(1);
    getEarliestLayerTime(layer).then(
      (time) => {
        if (!context.wasDisposed && earliestTimeSource === source) {
          earliestTime = time;
          timestampLimit.value = startOfLocalDay(time);
        }
      },
      () => {
        // Missing list permission or history is reported by the data source;
        // the picker just stays without a lower limit.
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
    // Second line of defence: `blockedSchemeOf` already keeps `|versioned:`
    // layers out of edit sessions, but a session must never see its layer's
    // data source swapped underneath it if that ever changes.
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
    intermediateTimestamp.changed.add(() => {
      if (!typing) applyDraft();
    }),
  );
  return {
    intermediateTimestamp,
    timestampLimit,
    historyStatus,
    versionMoments,
    /** Show the layer at `time` (`undefined` = latest data) right away. */
    chooseTime: (time: number | undefined) => {
      typing = false;
      intermediateTimestamp.value = time;
    },
    /** Re-read the version list for changes saved since it was read. */
    refreshChanges: () => {
      changesListing?.refresh();
    },
    /** Read further listing pages to find older changes of a large layer. */
    searchMoreChanges: () => {
      void changesListing?.readPages(MORE_CHANGES_PAGES);
    },
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
 * The "Bucket history" block of the Source tab for `dataSource`: shown under
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
