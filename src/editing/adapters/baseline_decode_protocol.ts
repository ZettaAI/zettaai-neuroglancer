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
 * Wire format between the baseline decode pool (main thread) and its worker
 * (TM-373). Dependency-free at runtime so it bundles cleanly into the worker.
 */

import type { CompressedBaselineChunk } from "#src/editing/adapters/baseline_chunk_decode.js";

/** Main thread → worker. `chunk.compressed` is transferred. */
export interface BaselineDecodeRequest {
  readonly id: number;
  readonly chunk: CompressedBaselineChunk;
}

/** Worker → main thread. `decoded` is transferred. */
export type BaselineDecodeResult =
  | { readonly id: number; readonly decoded: Uint32Array | BigUint64Array }
  | { readonly id: number; readonly error: string };
