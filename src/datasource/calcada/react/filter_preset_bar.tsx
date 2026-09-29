/** @jsxImportSource react */
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
 * @file Choosing, saving, renaming and deleting the user's filter presets.
 * Choosing copies a preset's tree into the filter; nothing changes a preset
 * until Save. Every prompt is inline — a browser dialog would freeze the
 * viewer's key handling.
 */

import { useState } from "react";

import type { FilterGroup } from "#src/datasource/calcada/candidate_filter_tree.js";
import { filterTreesEqual } from "#src/datasource/calcada/candidate_filter_tree.js";
import type {
  FilterPreset,
  FilterPresetsClient,
} from "#src/datasource/calcada/filter_presets.js";
import { FilterPresetNameTakenError } from "#src/datasource/calcada/filter_presets.js";
import { StatusMessage } from "#src/status.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NO_PRESET = "none";
const STATUS_MESSAGE_MS = 4000;

type Prompt =
  | { kind: "none" }
  | {
      kind: "name";
      action: "save-as" | "rename";
      text: string;
      overwrite?: FilterPreset;
      taken?: boolean;
    }
  | { kind: "confirm-delete" };

export type FilterPresetStore = Pick<
  FilterPresetsClient,
  "create" | "update" | "remove"
>;

export function FilterPresetBar({
  presets,
  store,
  tree,
  selectedId,
  onSelect,
  onChanged,
}: {
  presets: readonly FilterPreset[];
  store: FilterPresetStore;
  tree: FilterGroup;
  selectedId: string | undefined;
  onSelect: (preset: FilterPreset | undefined) => void;
  onChanged: (selectId: string | undefined) => void;
}) {
  const [prompt, setPrompt] = useState<Prompt>({ kind: "none" });
  const selected = presets.find((preset) => preset.id === selectedId);
  const dirty =
    selected?.tree !== undefined && !filterTreesEqual(selected.tree, tree);

  const run = async (work: () => Promise<string | undefined>) => {
    try {
      onChanged(await work());
      setPrompt({ kind: "none" });
    } catch (e) {
      if (e instanceof FilterPresetNameTakenError && prompt.kind === "name") {
        const existing = presets.find((p) => p.name === prompt.text.trim());
        setPrompt(
          prompt.action === "save-as" && existing !== undefined
            ? { ...prompt, overwrite: existing }
            : { ...prompt, taken: true },
        );
        return;
      }
      StatusMessage.showTemporaryMessage(
        `Filter preset not saved: ${e}`,
        STATUS_MESSAGE_MS,
      );
    }
  };

  const submitName = (namePrompt: Extract<Prompt, { kind: "name" }>) => {
    const name = namePrompt.text.trim();
    if (name === "") return;
    if (namePrompt.overwrite !== undefined) {
      const target = namePrompt.overwrite;
      void run(async () => (await store.update(target.id, { tree })).id);
    } else if (namePrompt.action === "save-as") {
      void run(async () => (await store.create(name, tree)).id);
    } else if (selected !== undefined) {
      void run(async () => (await store.update(selected.id, { name })).id);
    }
  };

  return (
    <div className="calcada-filter-preset-bar">
      <div className="calcada-filter-preset-row">
        <Select
          value={selectedId ?? NO_PRESET}
          onValueChange={(id) => onSelect(presets.find((p) => p.id === id))}
        >
          <SelectTrigger size="sm" className="calcada-filter-preset-select">
            <SelectValue>
              {selected ? `${selected.name}${dirty ? " •" : ""}` : "— none —"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PRESET}>— none —</SelectItem>
            {presets.map((preset) => (
              <SelectItem
                key={preset.id}
                value={preset.id}
                disabled={preset.tree === undefined}
              >
                {preset.tree === undefined
                  ? `${preset.name} (unusable)`
                  : preset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="xs"
          variant="outline"
          title={
            selected
              ? "Overwrite this preset with the filter"
              : "Save the filter as a new preset"
          }
          onClick={() =>
            selected
              ? void run(
                  async () => (await store.update(selected.id, { tree })).id,
                )
              : setPrompt({ kind: "name", action: "save-as", text: "" })
          }
        >
          Save
        </Button>
      </div>
      <div className="calcada-filter-preset-actions">
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            setPrompt({ kind: "name", action: "save-as", text: "" })
          }
        >
          Save as…
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={selected === undefined}
          onClick={() =>
            setPrompt({
              kind: "name",
              action: "rename",
              text: selected?.name ?? "",
            })
          }
        >
          Rename
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={selected === undefined}
          onClick={() => setPrompt({ kind: "confirm-delete" })}
        >
          Delete
        </Button>
      </div>
      {prompt.kind === "name" && (
        <form
          className="calcada-filter-preset-row"
          onSubmit={(event) => {
            event.preventDefault();
            submitName(prompt);
          }}
        >
          <Input
            autoFocus
            maxLength={100}
            placeholder="Preset name"
            value={prompt.text}
            onChange={(event) =>
              setPrompt({
                ...prompt,
                text: event.target.value,
                overwrite: undefined,
                taken: undefined,
              })
            }
          />
          <Button size="xs" type="submit">
            {prompt.overwrite ? "Overwrite" : "OK"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            type="button"
            onClick={() => setPrompt({ kind: "none" })}
          >
            Cancel
          </Button>
        </form>
      )}
      {prompt.kind === "name" && prompt.overwrite && (
        <div className="calcada-trace-panel-status">
          A preset with this name exists — overwrite it?
        </div>
      )}
      {prompt.kind === "name" && prompt.taken && (
        <div className="calcada-trace-panel-status">
          Another preset is already named “{prompt.text.trim()}” — choose a
          different name.
        </div>
      )}
      {prompt.kind === "confirm-delete" && selected && (
        <div className="calcada-filter-preset-row">
          <span className="calcada-trace-panel-status">
            Delete “{selected.name}”?
          </span>
          <Button
            size="xs"
            variant="destructive"
            onClick={() =>
              void run(async () => {
                await store.remove(selected.id);
                return undefined;
              })
            }
          >
            Delete
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setPrompt({ kind: "none" })}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
