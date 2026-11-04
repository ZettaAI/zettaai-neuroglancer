/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";

describe("paintProfiler auto-flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    paintProfiler.enabled = true;
    paintProfiler.resetWindow();
  });

  afterEach(() => {
    paintProfiler.autoFlush = true;
    paintProfiler.enabled = false;
    paintProfiler.resetWindow();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the window after 400 ms without a record", () => {
    paintProfiler.record("5.mirror.read(io)", 12);
    paintProfiler.count("mirror.syncs.full", 1);
    vi.advanceTimersByTime(400);
    expect(paintProfiler.snapshot()).toEqual({ buckets: {}, counters: {} });
  });

  it("keeps the window across pauses while autoFlush is off", () => {
    paintProfiler.autoFlush = false;
    paintProfiler.record("5.mirror.read(io)", 12);
    vi.advanceTimersByTime(5000);
    paintProfiler.record("5.mirror.read(io)", 30);
    paintProfiler.count("mirror.syncs.full", 1);
    vi.advanceTimersByTime(5000);
    expect(paintProfiler.snapshot()).toEqual({
      buckets: { "5.mirror.read(io)": { totalMs: 42, calls: 2, maxMs: 30 } },
      counters: { "mirror.syncs.full": 1 },
    });
  });
});
