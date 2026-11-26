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
 * The "Version history" block of the Source tab, driven in a real browser:
 * the section built by `makeVersionTimeSourceSection` (as the Source tab
 * mounts it), the real picker, and a real `VersionedKvStore` over a fake
 * bucket, so the history check and the earliest-time lookup run for real.
 */

import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObjectVersionHistoryCache } from "#src/kvstore/versioned/object_version_history_cache.js";
import type { ObjectVersionStore } from "#src/kvstore/versioned/object_version_store.js";
import type { ObjectVersionLifetime } from "#src/kvstore/versioned/version_at_time.js";
import { VersionedKvStore } from "#src/kvstore/versioned/versioned_kvstore.js";
import type { LayerDataSource } from "#src/layer/layer_data_source.js";
import { TrackableVersionTime } from "#src/layer/layer_version_time.js";
import { makeVersionTimeSourceSection } from "#src/layer/version_time_control.js";
import { RefCounted } from "#src/util/disposable.js";
import { HttpError } from "#src/util/http_request.js";
import { NullarySignal } from "#src/util/signal.js";
import {
  VERSION_TIME_LIVE_NOTE,
  VERSION_TIME_NO_PERMISSION_NOTE,
  VERSION_TIME_PAST_NOTE,
  VERSION_TIME_SECTION_TITLE,
} from "#src/widget/react/version_time_section.js";

const TIMEOUT = { timeout: 5000 };

// A bucket precomputed layer. Its URL stays the same at every time: the
// chosen time is layer state of its own (`versionTime`).
const CURRENT = "precomputed://gs://b/layer";

/** Yesterday at `hours:minutes:seconds` local time: always in the past. */
function yesterdayAt(hours: number, minutes: number, seconds: number) {
  const day = new Date();
  day.setDate(day.getDate() - 1);
  day.setHours(hours, minutes, seconds, 0);
  return day.valueOf();
}

type HistoryAnswer = "available" | "no-permission";

/**
 * Bucket under the layer: the history answer and when `info` first appeared.
 * Records the keys whose versions were listed.
 */
class FakeBucket implements ObjectVersionStore {
  listedKeys: string[] = [];
  /** Listing answers wait for this (a slow bucket). */
  answer: Promise<void> = Promise.resolve();
  constructor(
    private history: HistoryAnswer,
    private infoCreated: number | undefined,
  ) {}
  getUrl(key: string) {
    return `gs://b/${key}`;
  }
  async listObjectVersions(key: string): Promise<ObjectVersionLifetime[]> {
    this.listedKeys.push(key);
    await this.answer;
    if (this.history === "no-permission") {
      throw new HttpError("https://storage.googleapis.com/", 403, "Forbidden");
    }
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
  versionTime = new TrackableVersionTime();
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
    answer,
    time,
  }: {
    /** Time the layer is viewed at when the Source tab opens. */
    time?: number;
    history?: HistoryAnswer;
    infoCreated?: number;
    /** Listing answers wait for this (a slow bucket). */
    answer?: Promise<void>;
  } = {},
) {
  const bucket = new FakeBucket(history, infoCreated);
  if (answer !== undefined) bucket.answer = answer;
  const layer = new FakeLayer(urls, bucket);
  layer.versionTime.value = time;
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
    if (section === null) throw new Error("Version history not rendered yet");
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
  return layer.versionTime.value;
}

describe("Version history in the Source tab", () => {
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
    const { elements } = mountSourceSections([CURRENT], {
      time,
      history: "no-permission",
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_NO_PERMISSION_NOTE);
    expect(timeField(section)).not.toBeNull();
  });

  it("checks history by listing only the layer's info, not all its files", async () => {
    const { elements, bucket } = mountSourceSections([CURRENT], {
      infoCreated: yesterdayAt(12, 0, 0),
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_LIVE_NOTE);
    await vi.waitFor(
      () => expect(bucket.listedKeys).toEqual(["layer/info"]),
      TIMEOUT,
    );
  });

  it("the block keeps its height while the bucket is checked", async () => {
    let answer = () => {};
    const { elements, bucket } = mountSourceSections([CURRENT], {
      infoCreated: yesterdayAt(12, 0, 0),
      answer: new Promise<void>((resolve) => {
        answer = resolve;
      }),
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_LIVE_NOTE);
    await vi.waitFor(() => expect(bucket.listedKeys).toHaveLength(1), TIMEOUT);
    const whileChecking = section.getBoundingClientRect().height;
    answer();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(section.getBoundingClientRect().height).toBe(whileChecking);
  });

  it("a typed time is applied on Enter, not while typing", async () => {
    const start = yesterdayAt(12, 0, 0);
    const { layer, elements } = mountSourceSections([CURRENT], {
      time: start,
    });
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
    const { layer, elements } = mountSourceSections([CURRENT], {
      time: start,
    });
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
    const { layer, elements } = mountSourceSections([CURRENT], {
      time: yesterdayAt(13, 0, 0),
      infoCreated,
    });
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

  it("clearing the time returns to the latest data; the url never changes", async () => {
    const { layer, elements } = mountSourceSections([CURRENT], {
      time: yesterdayAt(12, 0, 0),
    });
    const section = await sectionShown(elements[0]);
    await noteShown(section, VERSION_TIME_PAST_NOTE);
    await userEvent.click(
      section.querySelector<HTMLElement>(
        'button[aria-label="Return to live"]',
      )!,
    );
    await vi.waitFor(() => {
      expect(chosenTime(layer)).toBeUndefined();
    }, TIMEOUT);
    expect(layer.dataSources[0].spec.url).toBe(CURRENT);
    await noteShown(section, VERSION_TIME_LIVE_NOTE);
  });
});
