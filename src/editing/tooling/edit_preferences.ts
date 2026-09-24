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
 * `editPreferences` — the **out-of-session-lifecycle state of edit-session
 * components** (TM-336). Unlike `editSession` (which describes one concrete
 * open session and is nulled on teardown), this block persists the last-used
 * choices of everything that lives *outside* a single session's lifecycle, so
 * the next session can be seeded with them. It is the source for:
 *
 *   - autofilling the resolution picker in the enter-edit-session modal
 *     (`resolutions`), and
 *   - seeding brush / keybind defaults at session open (`tooling`). The
 *     remembered active tool is deliberately not re-selected (TM-381):
 *     sessions always enter in navigation mode.
 *
 * Nothing here is ever trusted as ground truth: every value is re-validated
 * against fresh layer metadata when consumed (a remembered resolution missing
 * from the freshly-computed `availableResolutions` is dropped; a stale tool
 * binding is dropped by `paintingPatchFromPersist`). So no stale/cached data
 * can surface and no conflict detection is required — the modal output stays
 * the source of truth for the actual open.
 */

import type { Resolution as ResolutionType } from "@zettaai/edit-session";

import type { ToolingPersistState } from "#src/editing/tooling/tooling_persist.js";
import { parseTooling } from "#src/editing/tooling/tooling_persist.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

export interface EditPreferences {
  /**
   * Last-used resolution selection, keyed per `layerId`. The value is a list
   * (architected for multi-resolution-per-layer, TM-336) even though today the
   * modal selects exactly one resolution per layer. Re-validated against fresh
   * `availableResolutions` at modal open; stale entries are dropped and an
   * empty result falls back to the modal default.
   */
  readonly resolutions?: {
    readonly [layerId: string]: readonly ResolutionType[];
  };
  /**
   * Cross-session tool state: painting family config + per-user keybind
   * overrides (the stored active tool id is ignored at restore, TM-381). Same
   * shape as `editSession.tooling`, but survives session teardown so an
   * open → close → open flow keeps the user's tool parameters.
   */
  readonly tooling?: ToolingPersistState;
  /**
   * Whether a save that finds the region changed under it reconciles itself
   * instead of stopping to ask. Absent means {@link DEFAULT_AUTOMERGE}.
   *
   * On, a refused save folds the other side's voxels into every chunk it can
   * and RELOADS every chunk where both sides changed the same voxels —
   * dropping our edits there — then saves the result and reports what it did.
   * Off, every conflict raises the dialog and nothing moves until the user
   * answers.
   *
   * A preference rather than session state because it is a way of working,
   * not a property of one region: a tracer who wants merges wants them
   * tomorrow too.
   *
   * WHY THIS IS SAFE TO DEFAULT ON, given it lives in client-authored
   * `ngState` and so a session can set its own value: automerge resolves
   * every collision in the REMOTE's favour. The most a hostile or stale
   * state can cost is the local user's own unsaved paint — which is one undo
   * away, because the reconcile goes through the write protocol as a single
   * edit. It cannot authorize clobbering anyone else's work. That asymmetry
   * is the whole argument, and it is why this must never become the thing
   * that decides whether an OVERWRITE is allowed, only whether the user is
   * asked first. The refusal itself stays server-of-record in the scan.
   */
  readonly automerge?: boolean;
  /**
   * Merge strategy when a conflict is reconciled. Absent means
   * {@link DEFAULT_MERGE_STRATEGY}.
   *
   * "reload" (default) drops local edits in chunks where both sides changed
   * the same voxels, reloading those chunks from the remote.
   *
   * "keep-merge" uses the three-way merge result, which keeps local edits on
   * collisions (the merge kernel keeps mine when both sides disagree).
   */
  readonly mergeStrategy?: "reload" | "keep-merge";
}

/**
 * Conflicts reconcile themselves unless the user opts out.
 *
 * Note what this inverts: the tolerant parser below drops a malformed value,
 * so a malformed value now degrades to "merge without asking" rather than to
 * "ask me". What keeps that honest is not the parser — it is that a reconcile
 * is one undo step and always announces what it discarded.
 */
export const DEFAULT_AUTOMERGE = true;

/** Default merge strategy: reload chunks with collisions from the remote. */
export const DEFAULT_MERGE_STRATEGY: "reload" | "keep-merge" = "reload";

/**
 * Trackable wrapping the `editPreferences` block on `ngState`. The value is
 * `null` until the user has opened at least one session. Deliberately NOT
 * cleared on session teardown — that is the whole point of the block.
 */
export class TrackableEditPreferences implements Trackable {
  readonly value = new WatchableValue<EditPreferences | null>(null);
  readonly changed = new NullarySignal();

  constructor() {
    this.value.changed.add(this.changed.dispatch);
  }

  toJSON(): EditPreferences | null {
    return this.value.value;
  }

  restoreState(x: unknown): void {
    try {
      this.value.value = parseEditPreferences(x);
    } catch {
      this.reset();
    }
  }

  reset(): void {
    this.value.value = null;
  }
}

/**
 * Resolve the entry-modal autofill for one layer (TM-336): the remembered
 * resolutions intersected with what the layer currently offers, in `available`
 * order (matching the picker's normalization). Returns `undefined` when nothing
 * survives — the caller then keeps the modal default (highest resolution)
 * rather than autofilling an empty, un-submittable selection. This is the
 * re-validation that makes memoized resolutions safe against stale data.
 */
export function validateRememberedResolutions(
  remembered: readonly ResolutionType[] | undefined,
  available: readonly ResolutionType[],
): readonly ResolutionType[] | undefined {
  if (remembered === undefined) return undefined;
  const wanted = new Set(remembered);
  const kept = available.filter((r) => wanted.has(r));
  return kept.length > 0 ? kept : undefined;
}

/** Parse the per-layer resolution map. Tolerant: skips malformed entries. */
function parseResolutions(
  x: unknown,
): { [layerId: string]: readonly ResolutionType[] } | undefined {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return undefined;
  const out: { [layerId: string]: readonly ResolutionType[] } = {};
  for (const [layerId, raw] of Object.entries(x as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const resolutions = raw.filter(
      (r): r is ResolutionType => typeof r === "string",
    );
    if (resolutions.length > 0) out[layerId] = resolutions;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a persisted `editPreferences` block. Tolerant: a malformed sub-block is
 * dropped rather than discarding the whole thing. Returns `null` when there is
 * nothing usable.
 */
/**
 * Parse the automerge opt-out. A non-boolean is dropped rather than coerced,
 * so one malformed field cannot discard the user's unrelated preferences —
 * and, more importantly, so a truthy-but-not-`true` value written by another
 * build cannot be read here as consent.
 */
function parseAutomerge(x: unknown): boolean | undefined {
  return typeof x === "boolean" ? x : undefined;
}

/** Parse the merge strategy. Only recognizes the two valid strategies. */
function parseMergeStrategy(
  x: unknown,
): "reload" | "keep-merge" | undefined {
  if (x === "reload" || x === "keep-merge") return x;
  return undefined;
}

export function parseEditPreferences(x: unknown): EditPreferences | null {
  if (x === null || x === undefined) return null;
  if (typeof x !== "object") throw new Error("not-an-object");
  const obj = x as Record<string, unknown>;
  const resolutions = parseResolutions(obj.resolutions);
  const tooling = parseTooling(obj.tooling);
  const automerge = parseAutomerge(obj.automerge);
  const mergeStrategy = parseMergeStrategy(obj.mergeStrategy);
  if (
    resolutions === undefined &&
    tooling === undefined &&
    automerge === undefined &&
    mergeStrategy === undefined
  ) {
    return null;
  }
  return {
    ...(resolutions !== undefined ? { resolutions } : {}),
    ...(tooling !== undefined ? { tooling } : {}),
    ...(automerge !== undefined ? { automerge } : {}),
    ...(mergeStrategy !== undefined ? { mergeStrategy } : {}),
  };
}

/**
 * Whether this session reconciles conflicts without asking.
 *
 * Because the default is on and nothing writes the field until the user opts
 * out, the only value that ever reaches the URL is `false` — which is exactly
 * the one that has to survive a reload.
 */
export function automergeEnabled(preferences: EditPreferences | null): boolean {
  return preferences?.automerge ?? DEFAULT_AUTOMERGE;
}

/**
 * Merge strategy for reconciling conflicts: reload chunks with collisions
 * from the remote (default) or keep the merge result (keep local edits).
 */
export function getMergeStrategy(
  preferences: EditPreferences | null,
): "reload" | "keep-merge" {
  return preferences?.mergeStrategy ?? DEFAULT_MERGE_STRATEGY;
}
