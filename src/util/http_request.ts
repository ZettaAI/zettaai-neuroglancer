/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { ProgressListener } from "#src/util/progress_listener.js";

export class HttpError extends Error {
  url: string;
  status: number;
  statusText: string;
  response?: Response;

  constructor(
    url: string,
    status: number,
    statusText: string,
    response?: Response,
    options?: { cause: any },
  ) {
    let message = `Fetching ${JSON.stringify(
      url,
    )} resulted in HTTP error ${status}`;
    if (statusText) {
      message += `: ${statusText}`;
    }
    message += ".";
    super(message, options);
    this.name = "HttpError";
    this.message = message;
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    if (response) {
      this.response = response;
    }
  }

  static fromResponse(response: Response) {
    return new HttpError(
      response.url,
      response.status,
      response.statusText,
      response,
    );
  }

  static fromRequestError(input: RequestInfo, error: unknown) {
    if (error instanceof TypeError) {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else {
        url = input.url;
      }
      return new HttpError(url, 0, "Network or CORS error", undefined, {
        cause: error,
      });
    }
    return error;
  }
}

const maxAttempts = 32;
const minDelayMilliseconds = 500;
const maxDelayMilliseconds = 10000;

/**
 * Per-request overrides for the transient-retry loop, for callers whose request
 * must fail within a bounded time rather than retry for minutes.  The defaults
 * (no cap on how long an attempt may hang, {@link maxAttempts} retries) suit
 * background chunk reads, which are hedged and can afford to keep waiting; an
 * interactive write cannot.
 */
export interface RetryOptions {
  /** Total attempts before the failure propagates.  Defaults to {@link maxAttempts}. */
  maxAttempts?: number;
  /**
   * Deadline for a single attempt.  When it expires the attempt is aborted and
   * retried under the same attempt budget, so a request that is stuck (rather
   * than slow) does not hang forever.  Only applies to non-idempotent requests:
   * idempotent ones get their deadline from hedging instead.
   */
  attemptTimeoutMs?: number;
}

export function pickDelay(attemptNumber: number): number {
  // If `attemptNumber == 0`, delay is a random number of milliseconds between
  // `[minDelayMilliseconds, minDelayMilliseconds*2]`.  The lower and upper bounds of the interval
  // double with each successive attempt, up to the limit of
  // `[maxDelayMilliseconds/2,maxDelayMilliseconds]`.
  return (
    Math.min(
      2 ** attemptNumber * minDelayMilliseconds,
      maxDelayMilliseconds / 2,
    ) *
    (1 + Math.random())
  );
}

/**
 * If a request has not returned response headers within this interval, an additional identical
 * request is issued in parallel ("hedged").  On a clustered storage backend the extra request may be
 * routed to a healthy head node, which is the common cause of image chunks that otherwise hang
 * indefinitely.  At the concurrency cap this interval doubles as the final deadline before the
 * timeout error propagates.  It must sit comfortably above the real time-to-first-response so that
 * healthy-but-slow servers are not hedged needlessly.
 */
export const hedgeDelayMilliseconds = 7000;

/**
 * Maximum number of identical requests in flight at once for a single idempotent read.  Bounds both
 * the extra load from hedging and the total time a permanently stuck request waits before giving up
 * (roughly `maxConcurrentAttempts * hedgeDelayMilliseconds`).
 */
export const maxConcurrentAttempts = 3;

/**
 * Only idempotent reads are hedged; issuing a second POST/PUT/DELETE could apply a side effect
 * twice.
 */
function isIdempotentRequest(init: RequestInit | undefined): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

function combineAbortSignals(
  signals: (AbortSignal | null | undefined)[],
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal != null,
  );
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

type HedgedAttemptResult =
  | { kind: "headers"; controller: AbortController; response: Response }
  | { kind: "failed"; controller: AbortController; error: unknown };

/**
 * Issues `input` and, for each {@link hedgeDelayMilliseconds} that passes without response headers,
 * issues an additional identical request in parallel — up to {@link maxConcurrentAttempts} at once.
 * Resolves with the first response whose headers arrive (regardless of status) and aborts every
 * other attempt.  The winning attempt is deliberately left un-aborted so the caller can stream its
 * body under the original `signal`; a large or slow body download is therefore never duplicated.
 * A request cancelled by the caller's `signal` is never hedged.
 *
 * Racing only the wait for headers works because `fetch` resolves once response headers arrive,
 * before the body has downloaded.
 */
async function hedgeResponseHeaders(
  input: RequestInfo,
  init: RequestInitWithProgress | undefined,
  callerSignal: AbortSignal | null | undefined,
): Promise<Response> {
  const controllers = new Set<AbortController>();
  const liveAttempts = new Set<Promise<HedgedAttemptResult>>();
  let attemptsLaunched = 0;
  let lastError: unknown;

  const launchAttempt = () => {
    attemptsLaunched++;
    const controller = new AbortController();
    controllers.add(controller);
    const signal = combineAbortSignals([callerSignal, controller.signal]);
    const attempt: Promise<HedgedAttemptResult> = fetch(input, {
      ...init,
      signal,
    }).then(
      (response) => ({ kind: "headers", controller, response }),
      (error) => ({ kind: "failed", controller, error }),
    );
    liveAttempts.add(attempt);
  };

  launchAttempt();
  try {
    while (liveAttempts.size > 0) {
      callerSignal?.throwIfAborted();

      let hedgeTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const hedgeDeadline = new Promise<"deadline">((resolve) => {
        hedgeTimeoutId = setTimeout(
          () => resolve("deadline"),
          hedgeDelayMilliseconds,
        );
      });
      const settled = await Promise.race([
        ...[...liveAttempts].map((attempt) =>
          attempt.then((result) => ({ result, attempt })),
        ),
        hedgeDeadline,
      ]);
      clearTimeout(hedgeTimeoutId);

      if (settled === "deadline") {
        if (attemptsLaunched < maxConcurrentAttempts) {
          // Still slow but budget remains: race a fresh request against the in-flight one(s).
          launchAttempt();
          continue;
        }
        // Every allowed attempt is in flight and none has responded: give up.
        throw (
          lastError ?? new DOMException("Request timed out", "TimeoutError")
        );
      }

      const { result, attempt } = settled;
      liveAttempts.delete(attempt);
      if (result.kind === "headers") {
        // First headers win.  Drop the winner from the abort set so `finally` leaves it running to
        // stream its body; only the losing attempts are cancelled.
        controllers.delete(result.controller);
        return result.response;
      }
      // A network-level failure on one attempt; keep waiting on the others (or hedge again).
      lastError = result.error;
    }
    throw lastError ?? new DOMException("Request timed out", "TimeoutError");
  } finally {
    for (const controller of controllers) controller.abort();
  }
}

/** Resolve after `ms`, or early when `signal` aborts.  Never rejects. */
export function delayUnlessAborted(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal == null) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Whether `error` is a cancellation — a per-attempt timeout or an `abort()`. */
function isAbortLike(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Retries a `429`/`503`/`504` response with exponential backoff up to `attemptLimit` times; any
 * other error status throws an `HttpError`.  A network or CORS failure throws an `HttpError` with a
 * `status` of `0`.
 *
 * When `retryAttemptTimeouts` is set (the caller asked for a per-attempt deadline), an attempt that
 * aborts while the caller's own signal is still live is a stuck request, not a cancellation, and is
 * retried under the same budget.  An abort that follows the caller's signal always propagates.
 *
 * The backoff sleep resolves early on caller abort, so a cancel takes effect within the current
 * attempt rather than after the full delay; the loop's `throwIfAborted` then surfaces it.
 */
async function retryTransientStatus(
  input: RequestInfo,
  callerSignal: AbortSignal | null | undefined,
  sendRequest: () => Promise<Response>,
  attemptLimit: number,
  retryAttemptTimeouts: boolean,
): Promise<Response> {
  for (let requestAttempt = 0; ; ) {
    callerSignal?.throwIfAborted();
    let response: Response;
    try {
      response = await sendRequest();
    } catch (error) {
      if (
        retryAttemptTimeouts &&
        isAbortLike(error) &&
        callerSignal?.aborted !== true &&
        ++requestAttempt !== attemptLimit
      ) {
        await delayUnlessAborted(pickDelay(requestAttempt - 1), callerSignal);
        continue;
      }
      throw HttpError.fromRequestError(input, error);
    }
    if (!response.ok) {
      const { status } = response;
      if (status === 429 || status === 503 || status === 504) {
        // 429: Too Many Requests.  503: Service unavailable.  504: Gateway timeout.  Retry.
        if (++requestAttempt !== attemptLimit) {
          await delayUnlessAborted(pickDelay(requestAttempt - 1), callerSignal);
          continue;
        }
      }
      throw HttpError.fromResponse(response);
    }
    return response;
  }
}

/**
 * Issues a `fetch` request.
 *
 * If the request fails due to an HTTP status outside `[200, 300)`, throws an `HttpError`.  If the
 * request fails due to a network or CORS restriction, throws an `HttpError` with a `status` of `0`.
 *
 * If the request fails due to a transient error (429, 503, 504), retry.
 *
 * Idempotent (GET/HEAD) requests are additionally hedged: if response headers are slow to arrive, an
 * identical request is issued in parallel and the first to respond wins — see
 * {@link hedgeResponseHeaders}.  The slow original is never cancelled, so a request that was merely
 * slow (rather than stuck) can still win without discarding its progress.
 *
 * A non-idempotent request cannot be hedged (a second POST could apply the side effect twice), so it
 * has no deadline of its own unless the caller supplies {@link RetryOptions.attemptTimeoutMs} — see
 * {@link retryTransientStatus}.
 */
export async function fetchOk(
  input: RequestInfo,
  init?: RequestInitWithProgress,
): Promise<Response> {
  const callerSignal = init?.signal;
  const { maxAttempts: attemptLimit = maxAttempts, attemptTimeoutMs } =
    init?.retryOptions ?? {};
  // Idempotent requests take their deadline from hedging, so a per-attempt timeout applies only to
  // the non-hedged path.
  const perAttemptTimeoutMs = isIdempotentRequest(init)
    ? undefined
    : attemptTimeoutMs;
  const sendRequest = isIdempotentRequest(init)
    ? () => hedgeResponseHeaders(input, init, callerSignal)
    : perAttemptTimeoutMs !== undefined
      ? () =>
          // A FRESH deadline per attempt, composed inside the closure and never written back onto
          // `init`: retries here — and `BackendClient`'s 401 replay, which re-sends the same `init` —
          // must each get their own timer rather than inherit an already-expired one.
          fetch(input, {
            ...init,
            signal: combineAbortSignals([
              callerSignal,
              AbortSignal.timeout(perAttemptTimeoutMs),
            ]),
          })
      : () => fetch(input, init);
  return retryTransientStatus(
    input,
    callerSignal,
    sendRequest,
    attemptLimit,
    perAttemptTimeoutMs !== undefined,
  );
}

export interface RequestInitWithProgress extends RequestInit {
  progressListener?: ProgressListener;
  /** Per-request overrides for the transient-retry loop; see {@link RetryOptions}. */
  retryOptions?: RetryOptions;
}

export type FetchOk = (
  input: RequestInfo,
  init?: RequestInitWithProgress,
) => Promise<Response>;

export function isNotFoundError(e: any) {
  if (!(e instanceof HttpError)) return false;
  // Treat CORS errors (0) or 403 as not found.  S3 returns 403 if the file does not exist because
  // permissions are per-file.
  return e.status === 0 || e.status === 403 || e.status === 404;
}
