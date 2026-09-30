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
 * @file The user's filter library as the editor sees it: saved filters live
 * on calcada as presets, unsaved edits live in this browser as drafts, keyed
 * by preset id so a rename keeps them.
 */

import type { FilterParseError } from "#src/datasource/calcada/candidate_filter_text.js";
import {
  normalizeTargets,
  noteFor,
  sameFilter,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type { GroupNode } from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  emptyFilterTree,
  parseFilterDocument,
  serializeFilterTree,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import type {
  FilterPreset,
  FilterPresetsClient,
} from "#src/datasource/calcada/filter_presets.js";
import { findNode } from "#src/datasource/calcada/filter_tree_edits.js";
import { NullarySignal } from "#src/util/signal.js";

export const HISTORY_LIMIT = 200;

/** A draft as stored: the tree in its stored shape, its note on the root. */
export interface StoredDraft {
  tree: unknown;
}

export interface FilterDraftStore {
  load(): Record<string, StoredDraft>;
  save(drafts: Record<string, StoredDraft>): void;
}

export interface BadValue {
  raw: string;
  message: string;
}

export type LibraryStatus = "saved" | "unsaved" | "text-error" | "fix-value";

type PresetStore = Pick<
  FilterPresetsClient,
  "list" | "create" | "update" | "remove"
>;

interface Snapshot {
  drafts: Map<string, GroupNode>;
  current: string | undefined;
  label: string;
}

interface ParkedText {
  error: FilterParseError;
  text: string;
}

/** Drafts in localStorage. Private windows can refuse it; drafts then just don't survive a reload. */
export function browserDraftStore(key: string): FilterDraftStore {
  return {
    load: () => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "{}");
      } catch {
        return {};
      }
    },
    save: (drafts) => {
      try {
        localStorage.setItem(key, JSON.stringify(drafts));
      } catch {
        // Kept in memory only.
      }
    },
  };
}

const copy = (tree: GroupNode): GroupNode => structuredClone(tree);

function sameNote(a: GroupNode, b: GroupNode) {
  return (a.note ?? "") === (b.note ?? "");
}

export class FilterLibrary {
  readonly changed = new NullarySignal();

  private presets: FilterPreset[] = [];
  // Unsaved edits by preset id.
  private drafts = new Map<string, GroupNode>();
  private currentId: string | undefined;
  private history: Snapshot[] = [];
  private future: Snapshot[] = [];
  private error: ParkedText | undefined;
  private parked = new Map<string, ParkedText>();
  // Number boxes holding text that is not a valid value yet, by "id|field".
  private bad = new Map<string, BadValue>();
  private failedToLoad: string | undefined;

  constructor(
    private readonly client: PresetStore,
    private readonly store: FilterDraftStore,
  ) {}

  async load(): Promise<void> {
    try {
      this.presets = await this.client.list();
    } catch (e) {
      this.failedToLoad = String(e);
      this.changed.dispatch();
      throw e;
    }
    this.failedToLoad = undefined;
    let stored: Record<string, StoredDraft> = {};
    try {
      stored = this.store.load();
    } catch {
      // A store that refuses reads just has nothing to restore.
    }
    this.drafts = new Map();
    for (const [id, draft] of Object.entries(stored)) {
      const tree = parseFilterDocument(draft.tree);
      if (tree !== undefined && this.byId(id) !== undefined) {
        this.drafts.set(id, tree);
      }
    }
    this.changed.dispatch();
  }

  /** Why the library could not be read, until a load succeeds. */
  get loadError(): string | undefined {
    return this.failedToLoad;
  }

  get names(): string[] {
    return this.presets.map((preset) => preset.name);
  }

  get current(): string | undefined {
    return this.byId(this.currentId)?.name;
  }

  nameOf(presetId: string): string | undefined {
    return this.byId(presetId)?.name;
  }

  presetId(name: string): string | undefined {
    return this.byName(name)?.id;
  }

  select(name: string | undefined) {
    const next = name === undefined ? undefined : this.presetId(name);
    if (next === this.currentId) return;
    if (this.currentId !== undefined && this.error !== undefined) {
      this.parked.set(this.currentId, this.error);
    }
    this.currentId = next;
    this.error = next === undefined ? undefined : this.parked.get(next);
    if (next !== undefined) this.parked.delete(next);
    this.bad.clear();
    this.changed.dispatch();
  }

  saved(name: string): GroupNode | undefined {
    return this.byName(name)?.tree;
  }

  tree(name: string): GroupNode | undefined {
    const preset = this.byName(name);
    if (preset === undefined) return undefined;
    return this.drafts.get(preset.id) ?? preset.tree;
  }

  isDirty(name: string): boolean {
    const preset = this.byName(name);
    return preset !== undefined && this.drafts.has(preset.id);
  }

  /**
   * Changes the current filter; `label` names the step for undo. The user's
   * commented text goes when it no longer says what the tree says.
   */
  edit(
    change: (root: GroupNode) => GroupNode,
    label: string,
  ): { noteDropped: boolean } {
    const preset = this.byId(this.currentId);
    const tree = preset && this.tree(preset.name);
    if (preset === undefined || tree === undefined)
      return { noteDropped: false };
    const next = copy(change(copy(tree)));
    normalizeTargets(next);
    const noteDropped = next.note !== undefined && noteFor(next) === undefined;
    if (noteDropped) delete next.note;
    // The tree now says what the filter is: a broken text it replaced, and
    // invalid entries in boxes it changed or removed, are gone.
    this.dropTextError(preset.id);
    this.forgetBadValues(tree, next);
    this.remember(label);
    this.setDraft(preset, next);
    this.changed.dispatch();
    return { noteDropped };
  }

  /** The user's own text, kept while it still says what the tree says. */
  setNote(note: string | undefined) {
    const preset = this.byId(this.currentId);
    const tree = preset && this.tree(preset.name);
    if (preset === undefined || tree === undefined) return;
    if ((tree.note ?? undefined) === note) return;
    const next = copy(tree);
    if (note === undefined) delete next.note;
    else next.note = note;
    this.dropTextError(preset.id);
    this.remember("comment edit");
    this.setDraft(preset, next);
    this.changed.dispatch();
  }

  setTextError(error: FilterParseError | undefined, text?: string) {
    this.error = error === undefined ? undefined : { error, text: text ?? "" };
    this.changed.dispatch();
  }

  get textError(): FilterParseError | undefined {
    return this.error?.error;
  }

  get textDraft(): string | undefined {
    return this.error?.text;
  }

  setBadValue(key: string, value: BadValue | undefined) {
    if (value === undefined && !this.bad.has(key)) return;
    if (value === undefined) this.bad.delete(key);
    else this.bad.set(key, value);
    this.changed.dispatch();
  }

  badValue(key: string): BadValue | undefined {
    return this.bad.get(key);
  }

  get badValueCount(): number {
    return this.bad.size;
  }

  /** The invalid entries of one row, by field. */
  badValuesOf(id: string): [string, BadValue][] {
    return [...this.bad]
      .filter(([key]) => key.startsWith(`${id}|`))
      .map(([key, value]) => [key.split("|")[1], value]);
  }

  get status(): LibraryStatus {
    if (this.error !== undefined) return "text-error";
    if (this.bad.size > 0) return "fix-value";
    const name = this.current;
    return name !== undefined && this.isDirty(name) ? "unsaved" : "saved";
  }

  canSave(): boolean {
    return this.status === "unsaved";
  }

  async save(): Promise<void> {
    const preset = this.byId(this.currentId);
    if (preset === undefined || !this.canSave()) return;
    const tree = this.drafts.get(preset.id)!;
    const updated = await this.client.update(preset.id, { tree });
    this.replacePreset(updated);
    // Edits made while the save was on its way stay a draft.
    const latest = this.drafts.get(preset.id);
    if (latest === tree) this.dropDraft(preset.id);
    else if (latest !== undefined) this.setDraft(updated, latest);
    this.changed.dispatch();
  }

  revert() {
    if (this.currentId === undefined || !this.drafts.has(this.currentId)) {
      return;
    }
    this.remember("Revert");
    this.dropDraft(this.currentId);
    this.error = undefined;
    this.bad.clear();
    this.changed.dispatch();
  }

  /** The current edits become a new filter; the original stays as saved. */
  async saveAsNew(name: string): Promise<void> {
    const preset = this.byId(this.currentId);
    const tree = preset && this.tree(preset.name);
    if (preset === undefined || tree === undefined) return;
    const created = await this.client.create(name, tree);
    this.presets.push(created);
    if (this.drafts.get(preset.id) === tree) this.dropDraft(preset.id);
    if (this.currentId === preset.id) this.select(created.name);
    this.changed.dispatch();
  }

  async createNew(name: string): Promise<void> {
    const created = await this.client.create(name, emptyFilterTree());
    this.presets.push(created);
    this.select(created.name);
    this.changed.dispatch();
  }

  async rename(name: string): Promise<void> {
    const preset = this.byId(this.currentId);
    if (preset === undefined) return;
    this.replacePreset(await this.client.update(preset.id, { name }));
    this.changed.dispatch();
  }

  async remove(): Promise<void> {
    const preset = this.byId(this.currentId);
    if (preset === undefined) return;
    await this.client.remove(preset.id);
    const wasCurrent = this.currentId === preset.id;
    const index = this.presets.indexOf(preset);
    this.presets = this.presets.filter((other) => other.id !== preset.id);
    this.dropDraft(preset.id);
    this.parked.delete(preset.id);
    if (wasCurrent) {
      this.error = undefined;
      this.bad.clear();
      // The neighbour takes its place, as the prototype does.
      this.currentId =
        this.presets[Math.min(index, this.presets.length - 1)]?.id;
    }
    this.changed.dispatch();
  }

  /** "base", or "base 2", "base 3"… — whichever no filter has, ignoring case. */
  uniqueName(base: string): string {
    const taken = (name: string) =>
      this.presets.some(
        (preset) => preset.name.toLowerCase() === name.toLowerCase(),
      );
    let name = base;
    for (let suffix = 2; taken(name); suffix++) name = `${base} ${suffix}`;
    return name;
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Takes back the last step; returns its label. */
  undo(): string | undefined {
    return this.step(this.history, this.future);
  }

  redo(): string | undefined {
    return this.step(this.future, this.history);
  }

  private step(from: Snapshot[], to: Snapshot[]): string | undefined {
    const snapshot = from.pop();
    if (snapshot === undefined) return undefined;
    to.push(this.snapshot(snapshot.label));
    this.drafts = snapshot.drafts;
    this.currentId = snapshot.current;
    this.error = undefined;
    this.bad.clear();
    this.persist();
    this.changed.dispatch();
    return snapshot.label;
  }

  private snapshot(label: string): Snapshot {
    return {
      drafts: new Map([...this.drafts].map(([id, tree]) => [id, copy(tree)])),
      current: this.currentId,
      label,
    };
  }

  private remember(label: string) {
    this.history.push(this.snapshot(label));
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
  }

  // A draft that says what the saved filter says is no draft.
  private setDraft(preset: FilterPreset, tree: GroupNode) {
    if (
      preset.tree !== undefined &&
      sameFilter(tree, preset.tree) &&
      sameNote(tree, preset.tree)
    ) {
      this.drafts.delete(preset.id);
    } else {
      this.drafts.set(preset.id, tree);
    }
    this.persist();
  }

  private dropTextError(id: string) {
    if (id === this.currentId) this.error = undefined;
    this.parked.delete(id);
  }

  private forgetBadValues(before: GroupNode, after: GroupNode) {
    for (const key of [...this.bad.keys()]) {
      const [id, field] = key.split("|");
      const old = findNode(before, id)?.node as
        | Record<string, unknown>
        | undefined;
      const now = findNode(after, id)?.node as
        | Record<string, unknown>
        | undefined;
      if (now === undefined || old?.[field] !== now[field])
        this.bad.delete(key);
    }
  }

  private dropDraft(id: string) {
    this.drafts.delete(id);
    this.persist();
  }

  private persist() {
    const stored: Record<string, StoredDraft> = {};
    for (const [id, tree] of this.drafts) {
      stored[id] = { tree: serializeFilterTree(tree).root };
    }
    try {
      this.store.save(stored);
    } catch {
      // Kept in memory only.
    }
  }

  private replacePreset(updated: FilterPreset) {
    this.presets = this.presets.map((preset) =>
      preset.id === updated.id ? updated : preset,
    );
  }

  private byId(id: string | undefined) {
    return id === undefined
      ? undefined
      : this.presets.find((preset) => preset.id === id);
  }

  private byName(name: string) {
    return this.presets.find((preset) => preset.name === name);
  }
}
