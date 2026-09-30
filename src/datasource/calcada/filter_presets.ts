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
 * @file The signed-in user's saved candidate filters. The graph in the URL
 * only carries the request through calcada's access check; presets are the
 * user's across every graph.
 */

import type { HttpSource } from "#src/datasource/calcada/base.js";
import type { FilterGroup } from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  parseFilterTree,
  serializeFilterTree,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import { HttpError } from "#src/util/http_request.js";

const HTTP_CONFLICT = 409;

export interface FilterPreset {
  id: string;
  name: string;
  /** Undefined when this client cannot use the stored filter. */
  tree: FilterGroup | undefined;
  updatedAt: string;
}

export class FilterPresetNameTakenError extends Error {
  constructor(name: string) {
    super(`A filter preset named "${name}" already exists.`);
  }
}

function parsePreset(value: unknown): FilterPreset | undefined {
  const item = value as Record<string, unknown> | null;
  if (typeof item !== "object" || item === null) return undefined;
  if (typeof item.id !== "string" || typeof item.name !== "string")
    return undefined;
  return {
    id: item.id,
    name: item.name,
    tree: parseFilterTree(item.filter),
    updatedAt: typeof item.updated_at === "string" ? item.updated_at : "",
  };
}

export function parseFilterPresets(json: unknown): FilterPreset[] {
  if (!Array.isArray(json)) return [];
  return json
    .map(parsePreset)
    .filter((preset): preset is FilterPreset => preset !== undefined);
}

export class FilterPresetsClient {
  constructor(private httpSource: HttpSource) {}

  private get url() {
    return `${this.httpSource.baseUrl}/filter_presets`;
  }

  private async send(
    url: string,
    method: string,
    body: unknown,
    name?: string,
  ) {
    try {
      return await this.httpSource.fetchOkImpl(url, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (
        e instanceof HttpError &&
        e.status === HTTP_CONFLICT &&
        name !== undefined
      ) {
        throw new FilterPresetNameTakenError(name);
      }
      throw e;
    }
  }

  async list(): Promise<FilterPreset[]> {
    const response = await this.httpSource.fetchOkImpl(this.url, {});
    return parseFilterPresets(await response.json());
  }

  async create(name: string, tree: FilterGroup): Promise<FilterPreset> {
    const response = await this.send(
      this.url,
      "POST",
      { name, filter: serializeFilterTree(tree) },
      name,
    );
    return parsePreset(await response.json())!;
  }

  async update(
    id: string,
    change: { name?: string; tree?: FilterGroup },
  ): Promise<FilterPreset> {
    const body = {
      name: change.name,
      filter:
        change.tree === undefined
          ? undefined
          : serializeFilterTree(change.tree),
    };
    const response = await this.send(
      `${this.url}/${id}`,
      "PUT",
      body,
      change.name,
    );
    return parsePreset(await response.json())!;
  }

  async remove(id: string): Promise<void> {
    await this.send(`${this.url}/${id}`, "DELETE", undefined);
  }
}
