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
 * @file Waiting for a chunk's piece→root mapping instead of drawing without it.
 *
 * ClickHouse sleeps when idle and can take two minutes to answer the first
 * query. A chunk drawn without its mapping shows raw pieces, and a chunk is
 * loaded once, so it keeps showing them after its neighbours load with roots.
 * The mapping is asked for again until it comes; a chunk that never gets one
 * fails rather than showing pieces.
 */

import { delayUnlessAborted, HttpError } from "#src/util/http_request.js";

/** Comfortably above a cold start. */
export const LUT_RETRY_BUDGET_MS = 180_000;
const FIRST_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

export interface RetryClock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

const realClock: RetryClock = {
  now: () => Date.now(),
  wait: delayUnlessAborted,
};

/** Whether waiting can fix the failure: the server or the network, not the request. */
function worthRetrying(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError")
    return false;
  if (!(error instanceof HttpError)) return true;
  return (
    error.status >= HTTP_SERVER_ERROR ||
    error.status === HTTP_REQUEST_TIMEOUT ||
    error.status === HTTP_TOO_MANY_REQUESTS
  );
}

export async function fetchUntilAvailable<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal,
  { clock = realClock }: { clock?: RetryClock } = {},
): Promise<T> {
  const deadline = clock.now() + LUT_RETRY_BUDGET_MS;
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      signal.throwIfAborted();
      if (!worthRetrying(error) || clock.now() >= deadline) throw error;
      const delay = Math.min(
        FIRST_RETRY_DELAY_MS * 2 ** retry,
        MAX_RETRY_DELAY_MS,
      );
      await clock.wait(Math.min(delay, deadline - clock.now()), signal);
      signal.throwIfAborted();
    }
  }
}
