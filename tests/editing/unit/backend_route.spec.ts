/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import {
  BackendFaultQueue,
  E2E_BACKEND_ORIGIN,
  rewriteBackendUrl,
} from "#tests/editing/harness/backend_route.js";

describe("rewriteBackendUrl", () => {
  it("keeps the path and the repeated-key cutout query", () => {
    const sent =
      `${E2E_BACKEND_ORIGIN}/painting/cutout?path=precomputed%3A%2F%2Fgs%3A%2F%2Fb%2Fl` +
      "&bbox_start=0&bbox_start=0&bbox_start=0&resolution=16";
    expect(rewriteBackendUrl(sent, "http://127.0.0.1:4557/")).toBe(
      "http://127.0.0.1:4557/painting/cutout?path=precomputed%3A%2F%2Fgs%3A%2F%2Fb%2Fl" +
        "&bbox_start=0&bbox_start=0&bbox_start=0&resolution=16",
    );
  });
});

describe("BackendFaultQueue", () => {
  const conflict = { kind: "respond", status: 409 } as const;

  it("hands a fault to the first matching request only", () => {
    const queue = new BackendFaultQueue();
    queue.add("post", "/painting/cutout", conflict);
    expect(queue.take("GET", "/painting/cutout")).toBeUndefined();
    expect(queue.take("POST", "/segmentation/propagate_mask")).toBeUndefined();
    expect(queue.take("POST", "/painting/cutout")).toEqual(conflict);
    expect(queue.take("POST", "/painting/cutout")).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it("serves queued faults for one request in arrival order", () => {
    const queue = new BackendFaultQueue();
    const lie = { kind: "acknowledgeWithoutWriting" } as const;
    queue.add("POST", "/painting/cutout", conflict);
    queue.add("POST", "/painting/cutout", lie);
    expect(queue.take("POST", "/painting/cutout")).toEqual(conflict);
    expect(queue.take("POST", "/painting/cutout")).toEqual(lie);
  });

  it("answers every matching request with a standing fault until cleared", () => {
    const queue = new BackendFaultQueue();
    const outage = { kind: "respond", status: 500 } as const;
    queue.addStanding("POST", "/painting/cutout", outage);
    expect(queue.take("POST", "/painting/cutout")).toEqual(outage);
    expect(queue.take("POST", "/painting/cutout")).toEqual(outage);
    expect(queue.take("GET", "/painting/cutout")).toBeUndefined();
    queue.clear();
    expect(queue.take("POST", "/painting/cutout")).toBeUndefined();
  });

  it("serves a one-shot fault before a standing one", () => {
    const queue = new BackendFaultQueue();
    const outage = { kind: "respond", status: 500 } as const;
    queue.addStanding("POST", "/painting/cutout", outage);
    queue.add("POST", "/painting/cutout", conflict);
    expect(queue.take("POST", "/painting/cutout")).toEqual(conflict);
    expect(queue.take("POST", "/painting/cutout")).toEqual(outage);
  });

  it("matches a fault's required query parameters, ignoring the others", () => {
    const queue = new BackendFaultQueue();
    const outage = { kind: "respond", status: 500 } as const;
    queue.addStanding("POST", "/painting/cutout", outage, {
      path: "gs://bucket/b",
    });
    queue.add("POST", "/painting/cutout", conflict, { path: "gs://bucket/b" });
    const layerA = new URLSearchParams("path=gs://bucket/a&resolution=16");
    const layerB = new URLSearchParams("path=gs://bucket/b&resolution=16");
    expect(queue.take("POST", "/painting/cutout", layerA)).toBeUndefined();
    expect(queue.take("POST", "/painting/cutout")).toBeUndefined();
    expect(queue.take("POST", "/painting/cutout", layerB)).toEqual(conflict);
    expect(queue.take("POST", "/painting/cutout", layerB)).toEqual(outage);
    expect(queue.take("POST", "/painting/cutout", layerA)).toBeUndefined();
  });

  it("replaces a standing fault for the same request and query", () => {
    const queue = new BackendFaultQueue();
    const outage = { kind: "respond", status: 500 } as const;
    const unavailable = { kind: "respond", status: 503 } as const;
    queue.addStanding("POST", "/painting/cutout", outage);
    queue.addStanding("POST", "/painting/cutout", unavailable);
    expect(queue.take("POST", "/painting/cutout")).toEqual(unavailable);
  });
});
