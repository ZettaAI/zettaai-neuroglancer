/**
 * @file Network calls of the realign flow: the GPU field computation, and the
 * shapes of calcada's section/preview endpoints (which live on the calcada
 * graph server, reusing its authenticated HTTP source).
 */

import {
  APPLY_CORRESPONDENCES_PATH,
  type ApplyCorrespondencesResult,
  buildApplyCorrespondencesForm,
  parseApplyCorrespondencesResponse,
} from "#src/datasource/calcada/realign/apply_correspondences_request.js";
import type { CorrespondenceLine } from "#src/datasource/calcada/realign/realign_selection.js";
import { joinBackendUrl } from "#src/editing/backend/backend_client.js";
import type { BackendEndpoint } from "#src/editing/backend/backend_endpoint.js";
import { HttpError } from "#src/util/http_request.js";

export interface RealignCrop {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface RealignPreview {
  readonly previewId: string;
  readonly layerSource: string;
}

export type RealignErrorKind =
  | "unauthorized"
  | "too-large"
  | "busy"
  | "no-image"
  | "cancelled"
  | "failed";

export class RealignError extends Error {
  constructor(
    readonly kind: RealignErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RealignError";
  }
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const HTTP_UNAVAILABLE = 503;

const MESSAGES: Record<RealignErrorKind, string> = {
  unauthorized:
    "The GPU service rejected your Google login — sign in again with your zetta.ai account.",
  "too-large": "The box is too large for the GPU service — draw a smaller box.",
  busy: "The GPU service is busy — try Apply again in a moment.",
  "no-image":
    "This graph has no image at its resolution, so it cannot be realigned.",
  cancelled: "Realign cancelled.",
  failed: "Realign failed.",
};

export function errorKindForStatus(status: number): RealignErrorKind {
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN)
    return "unauthorized";
  if (status === HTTP_TOO_LARGE) return "too-large";
  if (status === HTTP_UNAVAILABLE) return "busy";
  if (status === HTTP_CONFLICT) return "no-image";
  return "failed";
}

export function realignErrorMessage(error: unknown): string {
  if (error instanceof RealignError) {
    return error.kind === "failed"
      ? `${MESSAGES.failed} ${error.message}`
      : MESSAGES[error.kind];
  }
  return `${MESSAGES.failed} ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Settles with `promise`, or rejects as cancelled once `signal` aborts — the
 * Google login behind `authorize` never rejects on its own, it waits for the
 * user to retry.
 */
function unlessCancelled<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const cancel = () =>
      reject(new RealignError("cancelled", "cancelled by the user"));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", cancel);
    });
  });
}

export async function applyCorrespondences(
  endpoint: BackendEndpoint,
  crop: RealignCrop,
  lines: readonly CorrespondenceLine[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ApplyCorrespondencesResult> {
  const body = await buildApplyCorrespondencesForm(
    crop.data,
    crop.width,
    crop.height,
    lines,
  );
  const init = await unlessCancelled(
    Promise.resolve(endpoint.authorize({ method: "POST", body })),
    signal,
  );
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/octet-stream");
  const response = await unlessCancelled(
    fetchImpl(joinBackendUrl(endpoint.baseUrl, APPLY_CORRESPONDENCES_PATH), {
      ...init,
      headers,
      signal,
    }),
    signal,
  );
  if (!response.ok) {
    throw new RealignError(
      errorKindForStatus(response.status),
      `HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return parseApplyCorrespondencesResponse(await response.arrayBuffer());
}

/**
 * A calcada refusal (4xx/5xx with a JSON `{error}` body) as a RealignError that
 * keeps calcada's own reason; anything else passes through unchanged.
 */
export async function calcadaRefusal(error: unknown): Promise<unknown> {
  if (!(error instanceof HttpError) || error.response === undefined) {
    return error;
  }
  const body = await error.response.text();
  try {
    return new RealignError(
      "failed",
      (JSON.parse(body) as { error: string }).error,
    );
  } catch {
    return new RealignError("failed", body || `HTTP ${error.status}`);
  }
}
