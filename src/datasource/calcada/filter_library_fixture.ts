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
 * @file Test fixture: a filter library over an in-memory preset store, as the
 * editor and Trace tests use it.
 */

import { parseFilterText } from "#src/datasource/calcada/candidate_filter_text.js";
import { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import type { FilterPreset } from "#src/datasource/calcada/filter_presets.js";

export async function libraryWith(filters: Record<string, string>) {
  let nextId = 1;
  const presets = new Map<string, FilterPreset>();
  for (const [name, text] of Object.entries(filters)) {
    const id = String(nextId++);
    presets.set(id, { id, name, tree: parseFilterText(text), updatedAt: "" });
  }
  const calls: string[] = [];
  const client: ConstructorParameters<typeof FilterLibrary>[0] = {
    list: async () => [...presets.values()],
    create: async (name, tree) => {
      calls.push(`create ${name}`);
      const preset = { id: String(nextId++), name, tree, updatedAt: "" };
      presets.set(preset.id, preset);
      return preset;
    },
    update: async (id, change) => {
      calls.push(`update ${id}`);
      const preset = { ...presets.get(id)!, ...change };
      presets.set(id, preset);
      return preset;
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
      presets.delete(id);
    },
  };
  const library = new FilterLibrary(client, {
    load: () => ({}),
    save: () => {},
  });
  await library.load();
  const first = Object.keys(filters)[0];
  if (first !== undefined) library.select(first);
  return { library, calls, client };
}
