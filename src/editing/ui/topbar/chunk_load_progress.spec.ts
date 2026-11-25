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
 * The topbar's preload badge on `done`: nothing for a clean load, and one
 * warning that names every way the load fell short — failed and skipped chunks
 * both, never one hiding the other.
 *
 * Written with `h` rather than JSX so it stays a `.spec.ts` in the node/jsdom
 * project. The host is a fake exposing only what the component reads.
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import type { ChunkLoadProgressState } from "#src/editing/adapters/session_chunk_preloader.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { ChunkLoadProgress } from "#src/editing/ui/topbar/chunk_load_progress.js";
import { WatchableValue } from "#src/trackable_value.js";

let container: HTMLDivElement | undefined;

afterEach(() => {
  if (container !== undefined) {
    act(() => render(null, container!));
    container.remove();
    container = undefined;
  }
});

/** Render the badge for `progress`; returns its element, if any. */
function renderBadge(progress: ChunkLoadProgressState): Element | null {
  const element = document.createElement("div");
  document.body.appendChild(element);
  container = element;
  const host = {
    chunkLoadProgress: new WatchableValue(progress),
  } as unknown as EditSessionHost;
  act(() => render(h(ChunkLoadProgress, { host }), element));
  return element.firstElementChild;
}

describe("ChunkLoadProgress on done", () => {
  it("renders nothing for a clean load", () => {
    expect(
      renderBadge({ kind: "done", total: 10, failed: 0, failures: [] }),
    ).toBeNull();
  });

  it("names skipped chunks", () => {
    const badge = renderBadge({
      kind: "done",
      total: 10,
      failed: 0,
      failures: [],
      skipped: 7,
    });
    expect(badge?.getAttribute("aria-label")).toBe("7 chunks not preloaded");
  });

  it("names failed and skipped chunks together", () => {
    const badge = renderBadge({
      kind: "done",
      total: 10,
      failed: 1,
      failures: [
        {
          layerId: "seg" as never,
          resolution: "8x8x8" as never,
          count: 1,
        },
      ],
      skipped: 6,
    });
    expect(badge?.getAttribute("aria-label")).toBe(
      "1 chunk unavailable · 6 chunks not preloaded",
    );
    expect(badge?.getAttribute("data-tooltip")).toBe(
      [
        "1 chunk unavailable — they will load on demand while painting",
        "seg @ 8x8x8: 1",
        "The edit region is larger than the viewer's memory budget: 6 of 10 chunks were not preloaded and load on demand while painting",
      ].join("\n"),
    );
  });
});
