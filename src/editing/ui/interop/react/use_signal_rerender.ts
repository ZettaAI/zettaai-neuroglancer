/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useReducer } from "react";

import type { NullarySignal } from "#src/util/signal.js";

/**
 * For objects that report through a bare signal rather than a watchable —
 * plain fields that change together, like a trace session's status and
 * candidate. A snapshot of them would have to be rebuilt on every read for
 * `useSyncExternalStore`, which cannot cache it, so the signal drives a
 * re-render and the fields are read during it.
 */
export function useSignalRerender(signal: NullarySignal) {
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    const unsubscribe = signal.add(rerender);
    return () => {
      unsubscribe();
    };
  }, [signal, rerender]);
}
