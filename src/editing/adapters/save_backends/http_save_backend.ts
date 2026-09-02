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
 * @file `HttpSaveBackend` (TM-348): a `SaveBackend` that writes dirty chunks
 * directly to the Zetta backend's `POST /painting/cutout` endpoint through the
 * shared {@link BackendClient}, rather than delegating the write to the portal.
 *
 * This is what lets a standalone neuroglancer (no portal) actually persist
 * edits: the same build-time / injected {@link BackendEndpoint} that powers the
 * tool compute backends also carries the URL + auth for the save write, so save
 * needs no separate wiring.
 *
 * The request is reconstructed entirely from NG-local data: the chunk arrives
 * carrying the `OwnedRegion` `planOwnedWrite` computed for it, which already
 * holds the grid and the bbox to post, so this never resolves a scale or
 * fetches the layer's `info` file. Bytes are posted native dtype, X-fastest,
 * gzipped, with no axis reorder — the `/cutout` default `is_fortran=true`
 * consumes that layout.
 */

import type { LayerId, LayerMetadata, SavedChunk } from "@zettaai/edit-session";

import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import type { BackendClient } from "#src/editing/backend/backend_client.js";
import type { OwnedChunkWrite } from "#src/editing/region/owned_chunk_write.js";
import { ownedRegionBytes } from "#src/editing/region/owned_chunk_write.js";
import { delayUnlessAborted, HttpError } from "#src/util/http_request.js";

/** Default backend path for the chunk write (relative to the endpoint root). */
const DEFAULT_CUTOUT_PATH = "/painting/cutout";

/**
 * Chunk uploads in flight at once within one layer (TM-455). A save is dominated
 * by per-request round-trip latency, not bandwidth — uploading strictly one
 * chunk at a time put a fully painted task at 15–20 min. Five is deliberately
 * modest: the backend and GCS speak HTTP/2 so these multiplex over a single
 * connection, and it still leaves a free connection under an HTTP/1.1
 * deployment (e.g. a local backend) for token refresh and tile loads.
 * `NgSaveTarget` keeps its per-layer loop sequential, so this is the total.
 */
export const SAVE_UPLOAD_CONCURRENCY = 5;

/**
 * Per-chunk retry budget for ONE upload attempt (TM-455). Without a per-attempt
 * deadline a stuck POST hangs forever, and the default 32 transient retries
 * burn ~4–5 min per chunk against a cold-starting backend. Five attempts of at
 * most 30 s each bound a single attempt at roughly 3 min and let a cancel land
 * within one attempt.
 *
 * NOT the per-chunk total. {@link CONFLICT_BACKOFF_MS} re-enters
 * `client.request` on a lost CAS race, so a chunk that alternates transient
 * failures with conflicts costs up to 4 x this budget — ~12 min while holding
 * one of {@link SAVE_UPLOAD_CONCURRENCY} slots. The two budgets are defined
 * independently and neither knows about the other; unifying them means teaching
 * `RetryOptions` a caller-supplied retryable-status predicate, which is
 * deliberately left out of this change.
 */
const SAVE_RETRY_OPTIONS = { maxAttempts: 5, attemptTimeoutMs: 30_000 };

/**
 * `detail` the backend returns on a lost compare-and-swap race for one chunk
 * object. The write is reported as PARTLY applied — the server writes chunks
 * one at a time with no rollback — so the client must replay the whole request.
 * With one POST per chunk "the whole request" is this chunk, and every payload
 * is an absolute replacement of the voxels it covers, so the replay is
 * idempotent.
 */
const CONFLICT_DETAIL = "conditional_write_conflict";

/**
 * Replays of one chunk after a lost CAS race. The backend already retries each
 * chunk internally before ever answering 409, so reaching the client means it
 * lost repeatedly on the same object. Task cutouts do not overlap in voxels
 * (measured across a real project: 0 overlapping task pairs, 78 pairs sharing a
 * boundary chunk), so the writers are racing over DISJOINT voxels and a replay
 * converges — hence a short, aggressive backoff rather than one tuned for
 * genuine contention.
 */
const CONFLICT_BACKOFF_MS: readonly number[] = [50, 150, 400];

export type Vec3 = [number, number, number];

/**
 * Derive the `/cutout` `path` from neuroglancer's canonical data-source URL,
 * mirroring the portal's mapping (TM-289):
 *   - precomputed: `gs://bucket/path|precomputed:` → `gs://bucket/path`
 *   - calcada:     `calcada://gs://bucket/path`    → `gs://bucket/path`
 *   - plain:       `gs://bucket/path`              → unchanged
 * Returns `undefined` when no usable path can be recovered.
 */
export function dataSourceUrlToCutoutPath(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;
  let path = url.trim();
  if (path.length === 0) return undefined;

  // Drop the `|<scheme>:` suffix NG appends (e.g. `|precomputed:`, `|n5:`).
  const pipeIndex = path.indexOf("|");
  if (pipeIndex !== -1) {
    path = path.slice(0, pipeIndex);
  }

  // Unwrap a leading `calcada://` wrapper, leaving the inner storage URL.
  if (path.startsWith("calcada://")) {
    path = path.slice("calcada://".length);
  }

  path = path.replace(/\/+$/, "");
  return path.length > 0 ? path : undefined;
}

/** Parse a `"8x8x40"` resolution key into a numeric `[x, y, z]` triple. */
export function parseResolution(resolution: string): Vec3 {
  const parts = resolution.split("x").map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid resolution key: "${resolution}"`);
  }
  return [parts[0], parts[1], parts[2]];
}

/** Build the `/cutout` query string (path + resolution + bbox), repeated-key form. */
export function buildCutoutParams(input: {
  path: string;
  resolution: Vec3;
  start: Vec3;
  end: Vec3;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.set("path", input.path);
  for (const r of input.resolution) params.append("resolution", String(r));
  for (const s of input.start) params.append("bbox_start", String(s));
  for (const e of input.end) params.append("bbox_end", String(e));
  return params;
}

/** Gzip a byte buffer, as `/cutout` requires (it always `gzip.decompress`es the body). */
async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  const compression = new CompressionStream("gzip");
  const writer = compression.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return new Response(compression.readable).arrayBuffer();
}

/**
 * Is this a lost compare-and-swap race the client should replay? Matches the
 * backend's structured `detail` rather than its prose, so the check does not
 * drift with wording.
 */
async function isConditionalWriteConflict(error: unknown): Promise<boolean> {
  if (!(error instanceof HttpError) || error.status !== 409) return false;
  const { response } = error;
  if (response === undefined) return false;
  try {
    const body = await response.clone().json();
    return body?.detail === CONFLICT_DETAIL;
  } catch {
    // A 409 whose body is unreadable or not the structured shape is not a
    // conflict we know how to replay safely.
    return false;
  }
}

export interface HttpSaveBackendDeps {
  /** Shared client carrying the backend endpoint (URL + auth). */
  readonly client: BackendClient;
  /** Resolve a layer's canonical data-source URL (→ the `/cutout` `path`). */
  readonly resolveDataSourceUrl?: (layerId: LayerId) => string | undefined;
  /** Override the write path (default `/painting/cutout`). */
  readonly cutoutPath?: string;
}

/**
 * `SaveBackend` that persists each dirty chunk via `POST /cutout` through the
 * shared {@link BackendClient}. Per-chunk outcomes aggregate into
 * succeeded / partial / failed `SaveBackendResult` states.
 */
export class HttpSaveBackend implements SaveBackend {
  private readonly client: BackendClient;
  private readonly resolveDataSourceUrl?: (
    layerId: LayerId,
  ) => string | undefined;
  private readonly cutoutPath: string;

  constructor(deps: HttpSaveBackendDeps) {
    this.client = deps.client;
    this.resolveDataSourceUrl = deps.resolveDataSourceUrl;
    this.cutoutPath = deps.cutoutPath ?? DEFAULT_CUTOUT_PATH;
  }

  async saveLayer(
    layerId: LayerId,
    chunks: readonly SavedChunk[],
    _metadata: LayerMetadata,
    signal: AbortSignal,
  ): Promise<SaveBackendResult> {
    if (chunks.length === 0) {
      return { status: "succeeded", layerId, chunkCount: 0 };
    }

    const path = dataSourceUrlToCutoutPath(
      this.resolveDataSourceUrl?.(layerId),
    );
    if (path === undefined) {
      return {
        status: "skipped",
        layerId,
        reason: "no data-source URL resolved for layer",
      };
    }

    let succeeded = 0;
    let failed = 0;
    let firstError: string | undefined;
    let cancelled = false;

    // Bounded worker pool over a shared cursor. JS is single-threaded, so the
    // shared counters only interleave at `await` points — no data race. On abort
    // the workers stop dequeuing, and only settled chunks are counted, keeping
    // the `cancelled-after-N-of-M` tally honest.
    let nextChunk = 0;
    const uploadWorker = async (): Promise<void> => {
      while (nextChunk < chunks.length) {
        if (signal.aborted) {
          cancelled = true;
          return;
        }
        const chunk = chunks[nextChunk++];
        try {
          await this.sendChunk(asOwnedWrite(chunk), path, signal);
          succeeded += 1;
        } catch (err) {
          if (signal.aborted) {
            cancelled = true;
            return;
          }
          failed += 1;
          firstError ??= err instanceof Error ? err.message : String(err);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SAVE_UPLOAD_CONCURRENCY, chunks.length) },
        () => uploadWorker(),
      ),
    );

    if (cancelled) {
      return {
        status: "partial",
        layerId,
        succeeded,
        failed,
        details: `cancelled-after-${succeeded + failed}-of-${chunks.length}`,
      };
    }
    if (failed === 0) {
      return { status: "succeeded", layerId, chunkCount: succeeded };
    }
    if (succeeded === 0) {
      return {
        status: "failed",
        layerId,
        error: firstError ?? "all chunks failed",
      };
    }
    return {
      status: "partial",
      layerId,
      succeeded,
      failed,
      details: firstError ?? "mixed-outcomes",
    };
  }

  /**
   * Write the owned part of one chunk. The box and its hash were pinned by
   * `planOwnedWrite` when the bytes were snapshotted; nothing here re-derives
   * them, so a replay writes exactly what the first attempt did.
   */
  private async sendChunk(
    write: OwnedChunkWrite,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { owned } = write;
    const params = buildCutoutParams({
      path,
      resolution: parseResolution(write.resolution),
      start: owned.ownedBox.start,
      end: owned.ownedBox.end,
    });
    // A whole-chunk region keeps the request chunk-aligned, which is what lets
    // the backend take its lock-free fast path instead of a read-modify-write.
    // `ownedRegionBytes` returns the live overlay buffer uncopied in that case,
    // so copy before handing it to the async gzip.
    const bytes = ownedRegionBytes(write.bytes.asView(), owned);
    const body = await gzip(owned.coversWholeChunk ? bytes.slice() : bytes);

    // `is_fortran` is left at its `/cutout` default (true), which consumes the
    // native-dtype, X-fastest bytes NG produces — no axis reorder needed.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.request(`${this.cutoutPath}?${params.toString()}`, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/octet-stream" },
          signal,
          retryOptions: SAVE_RETRY_OPTIONS,
        });
        return;
      } catch (error) {
        if (
          signal.aborted ||
          attempt >= CONFLICT_BACKOFF_MS.length ||
          !(await isConditionalWriteConflict(error))
        ) {
          throw error;
        }
        await delayUnlessAborted(CONFLICT_BACKOFF_MS[attempt], signal);
      }
    }
  }
}

/**
 * Every chunk reaching a save backend is planned by `planOwnedWrite` in
 * `NgSaveTarget`, so it carries its owned region. A chunk without one means the
 * planner was bypassed — writing it whole would overwrite voxels this task does
 * not own, silently, which is the bug this plumbing exists to prevent. Refuse
 * instead; the chunk is reported failed and its paint stays dirty.
 */
function asOwnedWrite(chunk: SavedChunk): OwnedChunkWrite {
  const write = chunk as OwnedChunkWrite;
  if (write.owned === undefined) {
    throw new Error(
      `chunk ${chunk.layerId}@${chunk.resolution}/${chunk.chunkId} has no ` +
        "owned region: refusing to write voxels this task may not own",
    );
  }
  return write;
}
