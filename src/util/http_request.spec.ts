/**
 * @license
 * Copyright 2024 Google Inc.
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOk,
  hedgeDelayMilliseconds,
  HttpError,
  maxConcurrentAttempts,
} from "#src/util/http_request.js";

// A request that never returns response headers on its own; it settles only when the signal passed
// to `fetch` is aborted (by a hedge losing, or by the caller cancelling).
function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
    );
  });
}

describe("fetchOk header hedging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the slow original alive: it can still win, and the hedge is aborted", async () => {
    const signals: AbortSignal[] = [];
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) => {
      signals.push(init!.signal!);
      // First attempt is slow (triggers a hedge) but ultimately answers; the hedge hangs and loses.
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return hangUntilAborted(init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = fetchOk("http://example.test/chunk");
    // No headers within the hedge delay: a second (parallel) request is issued.
    await vi.advanceTimersByTimeAsync(hedgeDelayMilliseconds);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The original — never cancelled — answers and wins.
    resolveFirst(new Response("ok", { status: 200 }));
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(signals[0].aborted).toBe(false); // winner (original) still running for its body
    expect(signals[1].aborted).toBe(true); // hedge (loser) cancelled
  });

  it("returns the hedged response when the first request is stuck", async () => {
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) return hangUntilAborted(init);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = fetchOk("http://example.test/chunk");
    await vi.advanceTimersByTimeAsync(hedgeDelayMilliseconds);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up with a timeout once the concurrency cap is reached", async () => {
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) =>
      hangUntilAborted(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = fetchOk("http://example.test/chunk").then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(
      hedgeDelayMilliseconds * maxConcurrentAttempts + 10,
    );

    expect(((await result) as DOMException).name).toBe("TimeoutError");
    expect(fetchMock).toHaveBeenCalledTimes(maxConcurrentAttempts);
  });

  it("does not hedge when the caller aborts", async () => {
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) =>
      hangUntilAborted(init),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const result = fetchOk("http://example.test/chunk", {
      signal: controller.signal,
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await vi.advanceTimersByTimeAsync(hedgeDelayMilliseconds * 3);

    const error = await result;
    expect((error as DOMException).name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not hedge non-idempotent POST requests", async () => {
    let sawAbort = false;
    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        sawAbort = true;
      });
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    void fetchOk("http://example.test/write", { method: "POST" }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(hedgeDelayMilliseconds * 5);

    expect(sawAbort).toBe(false);
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function alwaysRespondWith(status: number) {
  return vi.fn((_input: RequestInfo, _init?: RequestInit) =>
    Promise.resolve(new Response("body", { status })),
  );
}

function respondWithStatusSequence(statuses: number[]) {
  const fetchMock = vi.fn((_input: RequestInfo, _init?: RequestInit) => {
    const status =
      statuses[Math.min(fetchMock.mock.calls.length - 1, statuses.length - 1)];
    return Promise.resolve(new Response("body", { status }));
  });
  return fetchMock;
}

function recordSignalsAndHang(signals: AbortSignal[]) {
  return vi.fn((_input: RequestInfo, init?: RequestInit) => {
    signals.push(init!.signal!);
    return hangUntilAborted(init);
  });
}

function settlementOf(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ outcome: "resolved" as const, value }),
    (error: unknown) => ({ outcome: "rejected" as const, error }),
  );
}

function trackedSettlementOf(promise: Promise<unknown>) {
  const state = { settled: false };
  const result = settlementOf(promise).then((settlement) => {
    state.settled = true;
    return settlement;
  });
  return { state, result };
}

describe("fetchOk retryOptions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops after maxAttempts fetches when the server keeps answering 503", async () => {
    const fetchMock = alwaysRespondWith(503);
    vi.stubGlobal("fetch", fetchMock);

    const result = settlementOf(
      fetchOk("http://example.test/write", {
        method: "POST",
        retryOptions: { maxAttempts: 3 },
      }),
    );
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(60000);

    const settlement = await result;
    expect(settlement.outcome).toBe("rejected");
    expect((settlement as { error: HttpError }).error).toBeInstanceOf(
      HttpError,
    );
    expect((settlement as { error: HttpError }).error.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("still retries a transient 503 when no retryOptions are given", async () => {
    const fetchMock = respondWithStatusSequence([503, 200]);
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = fetchOk("http://example.test/write", {
      method: "POST",
    });
    await vi.advanceTimersByTimeAsync(60000);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a stuck attempt at attemptTimeoutMs and retries up to maxAttempts", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = recordSignalsAndHang(signals);
    vi.stubGlobal("fetch", fetchMock);

    const result = settlementOf(
      fetchOk("http://example.test/write", {
        method: "POST",
        retryOptions: { attemptTimeoutMs: 30000, maxAttempts: 3 },
      }),
    );
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(60000);

    const settlement = await result;
    expect(settlement.outcome).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(3);
  });

  it("does not retry when the caller cancels an in-flight attempt", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = recordSignalsAndHang(signals);
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const result = settlementOf(
      fetchOk("http://example.test/write", {
        method: "POST",
        signal: controller.signal,
        retryOptions: { attemptTimeoutMs: 30000, maxAttempts: 3 },
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await vi.advanceTimersByTimeAsync(60000);

    const settlement = await result;
    expect(settlement.outcome).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects promptly when the caller cancels during the backoff sleep", async () => {
    const fetchMock = alwaysRespondWith(503);
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const { state, result } = trackedSettlementOf(
      fetchOk("http://example.test/write", {
        method: "POST",
        signal: controller.signal,
        retryOptions: { maxAttempts: 3 },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.settled).toBe(false);

    controller.abort(new DOMException("Cancelled", "AbortError"));
    await vi.advanceTimersByTimeAsync(1);

    const settlement = await result;
    expect(settlement.outcome).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
