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
 * Route the built app's Zetta backend requests to a local web API (TM-331).
 *
 * The e2e configures the app's backend endpoint with {@link E2E_BACKEND_ORIGIN}
 * (via `editSessionHost.configureBackend`, the call the portal makes). Every
 * request to that origin is intercepted here and forwarded, body and all, to
 * the local web API from `webapi_server.mjs`; the answer is re-emitted with
 * the CORS + CORP headers the cross-origin-isolated page needs (as
 * `gcs_route.ts` does for storage reads).
 *
 * Two test affordances, both at the network edge so neither the client nor
 * the server carries test-only code:
 *
 * - a request journal ({@link BackendRoute.requests}) to assert what the client
 *   actually sent;
 * - one-shot faults ({@link BackendRoute.failNext}) that answer a matching
 *   request instead of forwarding it — a 500, a 409 conflict, or a 200 that
 *   was never written (`acknowledgeWithoutWriting`).
 */

import type { Page, Route } from "@playwright/test";

/** The origin the e2e app is told its backend lives at. Never resolvable. */
export const E2E_BACKEND_ORIGIN = "https://e2e-backend.test";

/** Map an intercepted backend URL onto the local web API, keeping path + query. */
export function rewriteBackendUrl(
  requestUrl: string,
  webApiUrl: string,
): string {
  const url = new URL(requestUrl);
  return webApiUrl.replace(/\/+$/, "") + url.pathname + url.search;
}

const CROSS_ORIGIN_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "*",
  "cross-origin-resource-policy": "cross-origin",
};

/** One request the app sent to the backend. */
export interface BackendRequestRecord {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly bodyBytes: number;
  /** Status the app received (forwarded or injected). */
  readonly status: number;
  /** Set when a fault answered instead of the web API. */
  readonly injectedFault?: BackendFault["kind"];
}

export type BackendFault =
  | {
      readonly kind: "respond";
      readonly status: number;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
    }
  /** Answer 200 without forwarding: the client believes a write that never happened. */
  | { readonly kind: "acknowledgeWithoutWriting" }
  /**
   * Never answer and never forward: the request hangs until `clearFaults`
   * (then it is aborted) or the page goes away. Nothing reaches storage.
   */
  | { readonly kind: "hang" };

/**
 * Query parameters a fault requires, e.g. `{ path: "gs://bucket/layer" }` to
 * fail the writes of one layer only. Absent: any query matches.
 */
export type FaultQuery = Readonly<Record<string, string>>;

interface PendingFault {
  readonly method: string;
  readonly pathname: string;
  readonly query: FaultQuery;
  readonly fault: BackendFault;
}

function sameTarget(
  pending: PendingFault,
  method: string,
  pathname: string,
  query: FaultQuery,
): boolean {
  return (
    pending.method === method.toUpperCase() &&
    pending.pathname === pathname &&
    JSON.stringify(pending.query) === JSON.stringify(query)
  );
}

function matches(
  pending: PendingFault,
  method: string,
  pathname: string,
  query: URLSearchParams,
): boolean {
  return (
    pending.method === method.toUpperCase() &&
    pending.pathname === pathname &&
    Object.entries(pending.query).every(
      ([name, value]) => query.get(name) === value,
    )
  );
}

/**
 * Faults waiting for their request. A one-shot fault matches by method,
 * pathname and its required query parameters, and is consumed by the first
 * matching request, in arrival order. A standing fault answers every matching
 * request until it is cleared, so a test does not depend on how many times the
 * client retries. One-shot faults win over a standing one.
 */
export class BackendFaultQueue {
  private readonly pending: PendingFault[] = [];
  private readonly standing: PendingFault[] = [];

  add(
    method: string,
    pathname: string,
    fault: BackendFault,
    query: FaultQuery = {},
  ): void {
    this.pending.push({ method: method.toUpperCase(), pathname, query, fault });
  }

  /** A later standing fault for the same method, pathname and query replaces it. */
  addStanding(
    method: string,
    pathname: string,
    fault: BackendFault,
    query: FaultQuery = {},
  ): void {
    const index = this.standing.findIndex((standing) =>
      sameTarget(standing, method, pathname, query),
    );
    if (index !== -1) this.standing.splice(index, 1);
    this.standing.push({
      method: method.toUpperCase(),
      pathname,
      query,
      fault,
    });
  }

  /** Drop every one-shot and standing fault. */
  clear(): void {
    this.pending.length = 0;
    this.standing.length = 0;
  }

  /** The fault that answers this request, if any (consuming a one-shot one). */
  take(
    method: string,
    pathname: string,
    query: URLSearchParams = new URLSearchParams(),
  ): BackendFault | undefined {
    const index = this.pending.findIndex((pending) =>
      matches(pending, method, pathname, query),
    );
    if (index !== -1) {
      const [taken] = this.pending.splice(index, 1);
      return taken.fault;
    }
    return this.standing.find((standing) =>
      matches(standing, method, pathname, query),
    )?.fault;
  }

  /** One-shot faults not yet consumed. */
  get size(): number {
    return this.pending.length;
  }
}

export interface BackendRoute {
  /** Every backend request so far, in order (CORS preflights excluded). */
  readonly requests: readonly BackendRequestRecord[];
  /**
   * Answer the next `method pathname` request carrying `query` with `fault`
   * instead of forwarding.
   */
  failNext(
    method: string,
    pathname: string,
    fault: BackendFault,
    query?: FaultQuery,
  ): void;
  /** Answer EVERY matching request with `fault` until `clearFaults`. */
  failAlways(
    method: string,
    pathname: string,
    fault: BackendFault,
    query?: FaultQuery,
  ): void;
  /** Drop all faults and abort every hanging request: requests are forwarded again. */
  clearFaults(): void;
  /** Requests currently held by a `hang` fault. */
  readonly hanging: number;
  /** One-shot faults queued but not yet consumed. */
  readonly pendingFaults: number;
}

async function fulfillWithFault(
  route: Route,
  fault: Exclude<BackendFault, { kind: "hang" }>,
): Promise<number> {
  if (fault.kind === "acknowledgeWithoutWriting") {
    await route.fulfill({
      status: 200,
      headers: { ...CROSS_ORIGIN_HEADERS, "content-type": "application/json" },
      body: "null",
    });
    return 200;
  }
  await route.fulfill({
    status: fault.status,
    headers: {
      ...CROSS_ORIGIN_HEADERS,
      "content-type": "application/json",
      ...fault.headers,
    },
    body: JSON.stringify(fault.body ?? null),
  });
  return fault.status;
}

/** Install the backend route on `page`. Call before the app sends a request. */
export async function installBackendRoute(
  page: Page,
  webApiUrl: string,
): Promise<BackendRoute> {
  const requests: BackendRequestRecord[] = [];
  const faults = new BackendFaultQueue();
  const held = new Set<() => void>();

  await page.route(`${E2E_BACKEND_ORIGIN}/**`, async (route: Route) => {
    const request = route.request();
    const method = request.method();
    if (method === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          ...CROSS_ORIGIN_HEADERS,
          "access-control-allow-methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
      return;
    }
    const url = new URL(request.url());
    const body = request.postDataBuffer() ?? undefined;
    const record = {
      method,
      pathname: url.pathname,
      query: url.searchParams,
      bodyBytes: body?.byteLength ?? 0,
    };

    const fault = faults.take(method, url.pathname, url.searchParams);
    if (fault?.kind === "hang") {
      requests.push({ ...record, status: 0, injectedFault: "hang" });
      await new Promise<void>((release) => held.add(release));
      // The client may have aborted already; there is nothing to answer then.
      await route.abort("aborted").catch(() => {});
      return;
    }
    if (fault !== undefined) {
      const status = await fulfillWithFault(route, fault);
      requests.push({ ...record, status, injectedFault: fault.kind });
      return;
    }

    const forwardHeaders = { ...request.headers() };
    delete forwardHeaders.host;
    delete forwardHeaders.origin;
    let response: Response;
    try {
      response = await fetch(rewriteBackendUrl(request.url(), webApiUrl), {
        method,
        headers: forwardHeaders,
        body:
          method === "GET" || method === "HEAD" || body === undefined
            ? undefined
            : new Uint8Array(body),
      });
    } catch (error) {
      requests.push({ ...record, status: 502 });
      await route.fulfill({
        status: 502,
        headers: CROSS_ORIGIN_HEADERS,
        body: `local web API unreachable: ${error}`,
      });
      return;
    }
    const responseHeaders: Record<string, string> = { ...CROSS_ORIGIN_HEADERS };
    for (const name of ["content-type", "retry-after"]) {
      const value = response.headers.get(name);
      if (value !== null) responseHeaders[name] = value;
    }
    const responseBody = Buffer.from(await response.arrayBuffer());
    requests.push({ ...record, status: response.status });
    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    });
  });

  return {
    requests,
    failNext: (method, pathname, fault, query) =>
      faults.add(method, pathname, fault, query),
    failAlways: (method, pathname, fault, query) =>
      faults.addStanding(method, pathname, fault, query),
    clearFaults: () => {
      faults.clear();
      for (const release of held) release();
      held.clear();
    },
    get hanging() {
      return held.size;
    },
    get pendingFaults() {
      return faults.size;
    },
  };
}
