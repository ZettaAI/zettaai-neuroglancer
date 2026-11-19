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
 * Baseline decode worker entry (TM-373): decodes one compressed-segmentation
 * chunk per message and transfers the dense, edit-sized result back.
 */

import { decodeCompressedBaseline } from "#src/editing/adapters/baseline_chunk_decode.js";
import type {
  BaselineDecodeRequest,
  BaselineDecodeResult,
} from "#src/editing/adapters/baseline_decode_protocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent) => {
  const { id, chunk } = event.data as BaselineDecodeRequest;
  try {
    const decoded = decodeCompressedBaseline(chunk);
    const result: BaselineDecodeResult = { id, decoded };
    scope.postMessage(result, [decoded.buffer]);
  } catch (error) {
    const result: BaselineDecodeResult = { id, error: String(error) };
    scope.postMessage(result);
  }
};

// The first message tells the pool this worker is ready.
scope.postMessage(null);
