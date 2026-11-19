/**
 * @license
 * Copyright 2026 Zetta AI.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The "Bucket history" block of the Source tab, driven in a real browser:
 * the section built by `makeVersionTimeSourceSection` (as the Source tab
 * mounts it), the real picker, and a real `VersionedKvStore` over a fake
 * bucket, so the history check and the earliest-time lookup run for real.
 */

import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObjectVersionHistoryCache } from "#src/kvstore/versioned/object_version_history_cache.js";
import type {
  ObjectChangesPage,
  ObjectVersionStore,
} from "#src/kvstore/versioned/object_version_store.js";
import { getVersionTimeFromUrl } from "#src/kvstore/versioned/url.js";
import type { ObjectVersionLifetime } from "#src/kvstore/versioned/version_at_time.js";
import { VersionedKvStore } from "#src/kvstore/versioned/versioned_kvstore.js";
import type { LayerDataSource } from "#src/layer/layer_data_source.js";
import { makeVersionTimeSourceSection } from "#src/layer/version_time_control.js";
import { RefCounted } from "#src/util/disposable.js";
import { HttpError } from "#src/util/http_request.js";
import { NullarySignal } from "#src/util/signal.js";
import {
  formatMoment,
  LATEST_VERSION_LABEL,
  NEWER_VERSION_LABEL,
  OLDER_VERSION_LABEL,
  PARTIAL_LIST_NOTE,
  SEARCH_MORE_LABEL,
} from "#src/widget/react/version_moment_list.js";
import {
  VERSION_TIME_LIVE_NOTE,
  VERSION_TIME_NO_PERMISSION_NOTE,
  VERSION_TIME_NONE_FOUND_NOTE,
  VERSION_TIME_PAST_NOTE,
  VERSION_TIME_SECTION_TITLE,
} from "#src/widget/react/version_time_section.js";

const TIMEOUT = { timeout: 5000 };

// A bucket precomputed layer with no time chosen: plain, editable URL.
const CURRENT = "precomputed://gs://b/layer";

/** `|versioned:` URL of the same layer at `time`. */
function pastUrl(time: number) {
  return `gs://b/layer/|versioned:@${new Date(time).toISOString()}/|neuroglancer-precomputed:`;
}

/** Yesterday at `hours:minutes:seconds` local time: always in the past. */
function yesterdayAt(hours: number, minutes: number, seconds: number) {
  const day = new Date();
  day.setDate(day.getDate() - 1);
  day.setHours(hours, minutes, seconds, 0);
  return day.valueOf();
}

type HistoryAnswer = "available" | "none-found" | "no-permission";

/**
 * Bucket under the layer: the history answer, when `info` first appeared,
 * and the write times listed page by page (one array per listing page).
 */
class FakeBucket implements ObjectVersionStore {
  listedPages = 0;
  /** Listing answers wait for this (a slow bucket). */
  answer: Promise<void> = Promise.resolve();
  constructor(
    private history: HistoryAnswer,
    private infoCreated: number | undefined,
    public changePages: number[][],
  ) {}
  getUrl(key: string) {
    return `gs://b/${key}`;
  }
  async listChangesUnder(
    _prefix: string,
    cursor: string | undefined,
  ): Promise<ObjectChangesPage> {
    if (this.history === "no-permission") {
      throw new HttpError("https://storage.googleapis.com/", 403, "Forbidden");
    }
    const page = cursor === undefined ? 0 : Number(cursor);
    ++this.listedPages;
    await this.answer;
    return {
      changeTimes: this.changePages[page] ?? [],
      hasEarlierVersion: this.history === "available",
      nextCursor:
        page + 1 < this.changePages.length ? String(page + 1) : undefined,
    };
  }
  async listObjectVersions(key: string): Promise<ObjectVersionLifetime[]> {
    if (this.infoCreated === undefined || !key.endsWith("info")) return [];
    return [
      {
        versionId: "1",
        liveFrom: this.infoCreated,
        liveUntil: undefined,
        writeOrder: 1n,
      },
    ];
  }
  async readObjectVersion() {
    return undefined;
  }
  async statObjectVersion() {
    return undefined;
  }
}

class FakeDataSource {
  constructor(
    public layer: FakeLayer,
    private spec_: { url: string },
  ) {}
  get spec() {
    return this.spec_;
  }
  set spec(spec: { url: string }) {
    this.spec_ = spec;
    this.layer.dataSourcesChanged.dispatch();
  }
}

class FakeLayer extends RefCounted {
  dataSourcesChanged = new NullarySignal();
  dataSources: FakeDataSource[];
  managedLayer = {
    name: "layer",
    manager: {
      root: {
        editSessionHost: { sessionLock: { isSessionLayer: () => false } },
      },
    },
  };
  manager;
  constructor(urls: string[], bucket: FakeBucket) {
    super();
    this.dataSources = urls.map((url) => new FakeDataSource(this, { url }));
    const historyCache = new ObjectVersionHistoryCache();
    const store = new VersionedKvStore(
      bucket as unknown as ConstructorParameters<typeof VersionedKvStore>[0],
      "layer/",
      undefined,
      historyCache,
    );
    this.manager = {
      dataSourceProviderRegistry: {
        sharedKvStoreContext: {
          kvStoreContext: {
            getKvStore: (url: string) => ({
              store,
              path: url.endsWith("|versioned:info") ? "info" : "",
            }),
          },
        },
      },
    };
  }
}

let mounted: { element: HTMLElement; dispose: () => void }[] = [];

afterEach(() => {
  for (const { element, dispose } of mounted) {
    dispose();
    element.remove();
  }
  mounted = [];
});

/** The Source-tab section of each data source, as `DataSourceView` mounts it. */
function mountSourceSections(
  urls: string[],
  {
    history = "available",
    infoCreated,
    changePages = [],
    answer,
  }: {
    history?: HistoryAnswer;
    infoCreated?: number;
    changePages?: number[][];
    /** Listing answers wait for this (a slow bucket). */
    answer?: Promise<void>;
  } = {},
) {
  const bucket = new FakeBucket(history, infoCreated, changePages);
  if (answer !== undefined) bucket.answer = answer;
  const layer = new FakeLayer(urls, bucket);
  const elements = layer.dataSources.map((dataSource) => {
    const widget = makeVersionTimeSourceSection(
      dataSource as unknown as LayerDataSource,
    );
    document.body.appendChild(widget.element);
    mounted.push({ element: widget.element, dispose: () => widget.dispose() });
    return widget.element;
  });
  return { layer, elements, bucket };
}

function sectionIn(element: HTMLElement) {
  return element.querySelector<HTMLElement>(
    `section[aria-label="${VERSION_TIME_SECTION_TITLE}"]`,
  );
}

function sectionShown(element: HTMLElement) {
  return vi.waitFor(() => {
    const section = sectionIn(element);
    if (section === null) throw new Error("Bucket history not rendered yet");
    return section;
  }, TIMEOUT);
}

function noteShown(section: HTMLElement, text: string) {
  return vi.waitFor(() => {
    expect(section.textContent).toContain(text);
  }, TIMEOUT);
}

function timeField(section: HTMLElement) {
  return section.querySelector<HTMLInputElement>(
    'input[aria-label="Time of day"]',
  );
}

function chosenTime(layer: FakeLayer) {
  return getVersionTimeFromUrl(layer.dataSources[0].spec.url);
}

describe("Bucket history in the Source tab", () => {
  it("is shown once per layer, under its first bucket data source", async () => {
    const { elements } = mountSourceSections([
      "precomputed://https://example.com/not-a-bucket",
      CURRENT,
      "precomputed://gs://b/other",
    ]);
    await sectionShown(elements[1]);
    expect(sectionIn(elements[0])).toBeNull();
    expect(sectionIn(elements[2])).toBeNull();
  });

  it("has history: picker and the live note", async () => {
    const { elements } = mountSourceSections([CURRENT]);
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_LIVE_NOTE);
    expect(timeField(section)).not.toBeNull();
    expect(section.querySelector('[role="status"]')).toBeNull();
  });

  it("no permission to list versions: picker hidden, permission note", async () => {
    const { elements } = mountSourceSections([CURRENT], {
      history: "no-permission",
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_NO_PERMISSION_NOTE);
    expect(timeField(section)).toBeNull();
    expect(section.querySelector('[role="status"]')?.textContent).toBe(
      VERSION_TIME_NO_PERMISSION_NOTE,
    );
  });

  it("no permission but a time already in the url: picker kept to clear it", async () => {
    const time = yesterdayAt(12, 0, 0);
    const { elements } = mountSourceSections([pastUrl(time)], {
      history: "no-permission",
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_NO_PERMISSION_NOTE);
    expect(timeField(section)).not.toBeNull();
  });

  it("no earlier versions found: warning, picker kept", async () => {
    const { elements } = mountSourceSections([CURRENT], {
      history: "none-found",
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_NONE_FOUND_NOTE);
    expect(timeField(section)).not.toBeNull();
    expect(section.querySelector('[role="status"]')?.textContent).toBe(
      VERSION_TIME_NONE_FOUND_NOTE,
    );
  });

  it("a typed time is applied on Enter, not while typing", async () => {
    const start = yesterdayAt(12, 0, 0);
    const { layer, elements } = mountSourceSections([pastUrl(start)]);
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_PAST_NOTE);
    const field = timeField(section)!;
    await userEvent.click(field);
    await userEvent.fill(field, "14:30:15");
    // Committed by the picker as a draft, but the layer is not reloaded yet.
    expect(chosenTime(layer)).toBe(start);
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      expect(chosenTime(layer)).toBe(yesterdayAt(14, 30, 15));
    }, TIMEOUT);
    // Enter keeps the focus in the field.
    expect(document.activeElement).toBe(field);
  });

  it("a typed time is applied when the field loses focus", async () => {
    const start = yesterdayAt(12, 0, 0);
    const { layer, elements } = mountSourceSections([pastUrl(start)]);
    const section = await sectionShown(elements[0]);
    const field = timeField(section)!;
    await userEvent.click(field);
    await userEvent.fill(field, "09:05:00");
    expect(chosenTime(layer)).toBe(start);
    field.blur();
    await vi.waitFor(() => {
      expect(chosenTime(layer)).toBe(yesterdayAt(9, 5, 0));
    }, TIMEOUT);
  });

  it("a time before the layer existed shows its first version", async () => {
    const infoCreated = yesterdayAt(12, 0, 0);
    const { layer, elements } = mountSourceSections(
      [pastUrl(yesterdayAt(13, 0, 0))],
      { infoCreated },
    );
    const section = await sectionShown(elements[0]);
    // The earliest time is looked up when the section mounts; the fake bucket
    // answers within a few microtasks, so one macrotask is plenty.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const field = timeField(section)!;
    await userEvent.click(field);
    // Same day, earlier than the layer's first `info`: the picker accepts it
    // (its limit is the start of that day), applying it clamps.
    await userEvent.fill(field, "08:00:00");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      expect(chosenTime(layer)).toBe(infoCreated);
    }, TIMEOUT);
    expect(field.value).toBe("12:00:00");
  });

  it("clearing the time returns to the plain, editable url", async () => {
    const { layer, elements } = mountSourceSections([
      pastUrl(yesterdayAt(12, 0, 0)),
    ]);
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_PAST_NOTE);
    await userEvent.click(
      section.querySelector<HTMLElement>(
        'button[aria-label="Return to live"]',
      )!,
    );
    await vi.waitFor(() => {
      expect(layer.dataSources[0].spec.url).toBe("precomputed://gs://b/layer");
    }, TIMEOUT);
    await noteShown(section, VERSION_TIME_LIVE_NOTE);
  });
});

describe("version list", () => {
  // Our real test: a copy, then a save that painted a blob, then one that
  // erased half of it. Each save wrote several chunks milliseconds apart.
  const copy = yesterdayAt(13, 38, 41);
  const painted = yesterdayAt(15, 1, 41);
  const erased = yesterdayAt(15, 2, 59);
  const writes = [copy - 53, copy, painted - 31, painted, erased - 31, erased];

  function trigger(section: HTMLElement) {
    return section.querySelector<HTMLElement>('[data-slot="select-trigger"]');
  }

  /** The dropdown's options, in order (they render in a portal). */
  function optionLabels() {
    return [
      ...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
    ].map(
      (item) =>
        item.querySelector('[data-slot="tooltip-trigger"]')?.textContent,
    );
  }

  async function openList(section: HTMLElement) {
    await vi.waitFor(() => expect(trigger(section)).not.toBeNull(), TIMEOUT);
    await userEvent.click(trigger(section)!);
  }

  function optionsShown(labels: string[]) {
    return vi.waitFor(() => expect(optionLabels()).toEqual(labels), TIMEOUT);
  }

  /** The version the dropdown shows (its label, without the arrow icon). */
  function shownVersion(section: HTMLElement) {
    return trigger(section)?.querySelector('[data-slot="tooltip-trigger"]')
      ?.textContent;
  }

  function button(section: HTMLElement, label: string) {
    return section.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
  }

  const ALL = [LATEST_VERSION_LABEL, formatMoment(painted), formatMoment(copy)];

  it("lists each save once, newest first; the newest is the latest data", async () => {
    const { elements } = mountSourceSections([CURRENT], {
      changePages: [writes],
    });
    const section = await sectionShown(elements[0]);
    await vi.waitFor(() => expect(shownVersion(section)).toBe(ALL[0]), TIMEOUT);
    await openList(section);
    await optionsShown(ALL);
  });

  it("picking a version shows the layer then; Latest returns to editable data", async () => {
    const { layer, elements } = mountSourceSections([CURRENT], {
      changePages: [writes],
    });
    const section = await sectionShown(elements[0]);
    await openList(section);
    await optionsShown(ALL);
    await userEvent.click(
      [
        ...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
      ][2],
    );
    await vi.waitFor(() => expect(chosenTime(layer)).toBe(copy), TIMEOUT);
    expect(shownVersion(section)).toBe(formatMoment(copy));
    await openList(section);
    await optionsShown(ALL);
    await userEvent.click(
      document.querySelector<HTMLElement>('[data-slot="select-item"]')!,
    );
    await vi.waitFor(
      () => expect(layer.dataSources[0].spec.url).toBe(CURRENT),
      TIMEOUT,
    );
  });

  it("◀ ▶ step through the versions", async () => {
    const { layer, elements } = mountSourceSections([CURRENT], {
      changePages: [writes],
    });
    const section = await sectionShown(elements[0]);
    await vi.waitFor(() => expect(shownVersion(section)).toBe(ALL[0]), TIMEOUT);
    expect(button(section, NEWER_VERSION_LABEL).disabled).toBe(true);
    await userEvent.click(button(section, OLDER_VERSION_LABEL));
    await vi.waitFor(() => expect(chosenTime(layer)).toBe(painted), TIMEOUT);
    await userEvent.click(button(section, OLDER_VERSION_LABEL));
    await vi.waitFor(() => expect(chosenTime(layer)).toBe(copy), TIMEOUT);
    await vi.waitFor(
      () => expect(button(section, OLDER_VERSION_LABEL).disabled).toBe(true),
      TIMEOUT,
    );
    await userEvent.click(button(section, NEWER_VERSION_LABEL));
    await vi.waitFor(() => expect(chosenTime(layer)).toBe(painted), TIMEOUT);
    await userEvent.click(button(section, NEWER_VERSION_LABEL));
    await vi.waitFor(
      () => expect(layer.dataSources[0].spec.url).toBe(CURRENT),
      TIMEOUT,
    );
  });

  it("a time typed between versions is shown as it is", async () => {
    const between = painted + 10_000;
    const { elements } = mountSourceSections([pastUrl(between)], {
      changePages: [writes],
    });
    const section = await sectionShown(elements[0]);
    await vi.waitFor(
      () => expect(shownVersion(section)).toBe(formatMoment(between)),
      TIMEOUT,
    );
  });

  it("opening the list picks up a save made since", async () => {
    const { elements, bucket } = mountSourceSections([CURRENT], {
      changePages: [writes],
    });
    const section = await sectionShown(elements[0]);
    await vi.waitFor(() => expect(shownVersion(section)).toBe(ALL[0]), TIMEOUT);
    expect(bucket.listedPages).toBe(1);
    const saved = erased + 9000;
    bucket.changePages = [[...writes, saved]];
    await openList(section);
    await optionsShown([
      LATEST_VERSION_LABEL,
      formatMoment(erased),
      formatMoment(painted),
      formatMoment(copy),
    ]);
    expect(bucket.listedPages).toBe(2);
  });

  it("a large layer is listed one page at a time, on request", async () => {
    const { elements, bucket } = mountSourceSections([CURRENT], {
      changePages: [[copy], [painted], [erased]],
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, PARTIAL_LIST_NOTE);
    // Opening the Source tab reads one page: the history check itself.
    expect(bucket.listedPages).toBe(1);
    // Not everything listed: the newest found is not known to be the
    // latest data, so it is listed as a version of its own.
    await openList(section);
    await optionsShown([LATEST_VERSION_LABEL, formatMoment(copy)]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      [...section.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === SEARCH_MORE_LABEL,
      )!,
    );
    await vi.waitFor(
      () => expect(section.textContent).not.toContain(PARTIAL_LIST_NOTE),
      TIMEOUT,
    );
    // Source tab open (1) + re-read on opening the list (1) + 2 more pages.
    expect(bucket.listedPages).toBe(4);
    // Opening the list again re-reads as far as was read: all 3 pages, so
    // the versions found by "Search more files" stay listed.
    await openList(section);
    await optionsShown(ALL);
    expect(bucket.listedPages).toBe(7);
  });

  it("no permission: no list", async () => {
    const { elements } = mountSourceSections([CURRENT], {
      history: "no-permission",
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_NO_PERMISSION_NOTE);
    expect(trigger(section)).toBeNull();
  });

  it("the block keeps its height while the bucket is checked", async () => {
    let answer = () => {};
    const { elements } = mountSourceSections([CURRENT], {
      changePages: [writes],
      answer: new Promise<void>((resolve) => {
        answer = resolve;
      }),
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_LIVE_NOTE);
    const whileChecking = section.getBoundingClientRect().height;
    answer();
    await vi.waitFor(() => expect(shownVersion(section)).toBe(ALL[0]), TIMEOUT);
    expect(section.getBoundingClientRect().height).toBe(whileChecking);
  });
});
