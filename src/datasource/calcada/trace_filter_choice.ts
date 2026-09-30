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
 * @file Which saved filter the Trace tab uses. Trace always evaluates a saved
 * version: unsaved edits in the editor never reach it.
 */

import { sameFilter } from "#src/datasource/calcada/candidate_filter_text.js";
import { emptyFilterTree } from "#src/datasource/calcada/candidate_filter_tree.js";
import type { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import type { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import type { Disposer } from "#src/util/disposable.js";

export function chooseTraceFilter(
  state: ZettaTraceState,
  library: FilterLibrary,
  name: string | undefined,
) {
  const saved = name === undefined ? undefined : library.saved(name);
  state.filterPresetId.value = saved && library.presetId(name!);
  state.filter.value = saved ?? emptyFilterTree();
}

/**
 * Keeps Trace on the saved version of its filter as the library saves it. A
 * linked filter the library does not have is left as the link gave it.
 */
export function followSavedTraceFilter(
  state: ZettaTraceState,
  library: FilterLibrary,
): Disposer {
  return library.changed.add(() => {
    const id = state.filterPresetId.value;
    const name = id === undefined ? undefined : library.nameOf(id);
    const saved = name === undefined ? undefined : library.saved(name);
    if (saved !== undefined && !sameFilter(saved, state.filter.value)) {
      state.filter.value = saved;
    }
  });
}
