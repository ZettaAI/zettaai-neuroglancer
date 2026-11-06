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
 * A small worker pool that decodes compressed-segmentation baselines off the
 * main thread (TM-373). Modeled on `brush_worker_pool.ts` (free list + queue,
 * first message as the ready handshake). The compressed block is the caller's
 * own copy and is transferred in; the decoded buffer is transferred back, so
 * neither direction copies.
 *
 * Without `Worker` (node tests) or after a worker fails to load, chunks decode
 * on the main thread as before.
 */

import {
  decodeCompressedBaseline,
  type CompressedBaselineChunk,
} from "#src/editing/adapters/baseline_chunk_decode.js";
import type {
  BaselineDecodeRequest,
  BaselineDecodeResult,
} from "#src/editing/adapters/baseline_decode_protocol.js";

type DecodedBaseline = Uint32Array | BigUint64Array;

interface DecodeTask {
  readonly request: BaselineDecodeRequest;
  readonly resolve: (decoded: DecodedBaseline) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * One decode of a 4096² uint64 chunk is ~400 ms and allocates 128 MB; two at
 * once cover a stroke that first-touches a chunk junction without competing
 * with the brush workers for every core.
 */
const MAX_WORKERS = 2;

let launchedWorkers = 0;
let workersUnavailable = false;
const idleWorkers: Worker[] = [];
const queuedTasks: DecodeTask[] = [];
const runningTasks = new Map<number, DecodeTask>();
let nextTaskId = 0;

function post(worker: Worker, task: DecodeTask): void {
  runningTasks.set(task.request.id, task);
  worker.postMessage(task.request, [task.request.chunk.compressed.buffer]);
}

function hand(worker: Worker): void {
  const task = queuedTasks.shift();
  if (task === undefined) idleWorkers.push(worker);
  else post(worker, task);
}

/** Decode everything still queued on the main thread, and stop using workers. */
function fallBackToMainThread(detail: string): void {
  console.warn(`[baseline-decode] ${detail}; decoding on the main thread`);
  workersUnavailable = true;
  idleWorkers.length = 0;
  for (const task of queuedTasks.splice(0)) decodeHere(task);
  const lost = new Error(`baseline decode worker failed: ${detail}`);
  for (const [id, task] of runningTasks) {
    runningTasks.delete(id);
    task.reject(lost);
  }
}

function decodeHere(task: DecodeTask): void {
  try {
    task.resolve(decodeCompressedBaseline(task.request.chunk));
  } catch (error) {
    task.reject(error);
  }
}

function launchWorker(): void {
  ++launchedWorkers;
  // A literal `new URL(..., import.meta.url)` is required for bundler worker
  // resolution (no `#src/...` subpath import).
  const worker = new Worker(
    /* webpackChunkName: "neuroglancer_baseline_decode_worker" */
    new URL("../../baseline_decode_worker.bundle.js", import.meta.url),
    { type: "module" },
  );
  let ready = false;
  worker.onmessage = (event: MessageEvent) => {
    if (!ready) {
      ready = true;
      hand(worker);
      return;
    }
    const result = event.data as BaselineDecodeResult;
    const task = runningTasks.get(result.id);
    runningTasks.delete(result.id);
    hand(worker);
    if (task === undefined) return;
    if ("error" in result) task.reject(new Error(result.error));
    else task.resolve(result.decoded);
  };
  worker.onerror = (event: ErrorEvent) => {
    fallBackToMainThread(
      event.message
        ? `worker error: ${event.message}`
        : "worker failed to load",
    );
  };
}

/**
 * Decode `chunk` (see `decodeCompressedBaseline`) on a worker. Takes ownership
 * of `chunk.compressed`: its buffer is transferred and must not be used after.
 */
export function decodeBaselineOffMainThread(
  chunk: CompressedBaselineChunk,
): Promise<DecodedBaseline> {
  return new Promise<DecodedBaseline>((resolve, reject) => {
    const task: DecodeTask = {
      request: { id: nextTaskId++, chunk },
      resolve,
      reject,
    };
    if (workersUnavailable || typeof Worker === "undefined") {
      decodeHere(task);
      return;
    }
    const worker = idleWorkers.pop();
    if (worker !== undefined) {
      post(worker, task);
      return;
    }
    queuedTasks.push(task);
    if (launchedWorkers < MAX_WORKERS) launchWorker();
  });
}
