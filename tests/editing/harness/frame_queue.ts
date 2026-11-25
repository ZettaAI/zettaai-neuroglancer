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
 * The node test project has no `requestAnimationFrame`. Queue the callbacks
 * instead, so a test decides when each frame runs. Call `vi.unstubAllGlobals()`
 * in `afterEach`.
 */

import { vi } from "vitest";

export interface FrameQueue {
  /** Run every callback queued before this call. */
  runFrame(): void;
  readonly pendingCount: number;
}

export function installFrameQueue(): FrameQueue {
  let queued = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    queued.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    queued.delete(handle);
  });
  return {
    runFrame: () => {
      const callbacks = [...queued.values()];
      queued = new Map();
      for (const callback of callbacks) callback(0);
    },
    get pendingCount() {
      return queued.size;
    },
  };
}
