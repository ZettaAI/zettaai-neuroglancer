/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  EditSession,
  LayerId,
  SaveLayerOutcome,
  SaveResult,
} from "@zettaai/edit-session";

import type {
  EditSessionHost,
  MergeConflictsOutcome,
} from "#src/editing/edit_session_host.js";
import type {
  SaveConflictError,
  SaveConflictPolicy,
} from "#src/editing/reconcile/save_conflict_refusal.js";
import { isSaveConflictError } from "#src/editing/reconcile/save_conflict_refusal.js";
import { conflictStrategyOf } from "#src/editing/tooling/edit_preferences.js";
import { NullarySignal } from "#src/util/signal.js";

export type SaveAllState =
  | { kind: "idle"; lastSavedAt?: number }
  | { kind: "saving"; controller: AbortController }
  | { kind: "done-success"; savedAt: number }
  | { kind: "done-partial"; failedLayers: readonly string[] };

export interface PerLayerSaveStatus {
  readonly layerId: LayerId;
  readonly writable: boolean;
  readonly status: "succeeded" | "failed" | "skipped" | "partial" | "pending";
  readonly detail: string;
}

export class SaveTracker {
  readonly changed = new NullarySignal();

  private state_: SaveAllState = { kind: "idle" };
  private layerStatuses_: Map<string, PerLayerSaveStatus>;
  private saveStartedAt_ = 0;
  private autoClearTimer_: ReturnType<typeof setTimeout> | undefined;
  private conflict_: SaveConflictError | undefined;

  constructor(host: EditSessionHost, session: EditSession) {
    this.layerStatuses_ = initializeLayerStatuses(host, session);
  }

  get state(): SaveAllState {
    return this.state_;
  }

  get layerStatuses(): ReadonlyMap<string, PerLayerSaveStatus> {
    return this.layerStatuses_;
  }

  /**
   * A clear, user-facing message describing why the last save did not fully
   * succeed — or `undefined` if the last save succeeded or none has run. Built
   * from the failed layers' detail strings (the backend / verification error
   * text), so the caller can surface it as a toast. The detail strings are
   * already user-facing (see `NgSaveTarget`).
   */
  lastFailureMessage(): string | undefined {
    if (this.state_.kind !== "done-partial") return undefined;
    const failed = this.state_.failedLayers;
    if (failed.length === 0) return undefined;
    const details: string[] = [];
    for (const id of failed) {
      const detail = this.layerStatuses_.get(id)?.detail;
      if (
        detail !== undefined &&
        detail.length > 0 &&
        !details.includes(detail)
      ) {
        details.push(detail);
      }
    }
    const body =
      details.length > 0 ? details.join(" ") : "The save didn't complete.";
    // Name the affected layers only when more than one writable layer failed,
    // so the common single-layer case stays a clean one-liner.
    if (failed.length > 1) {
      return `Couldn't save ${failed.length} layers (${failed.join(", ")}). ${body}`;
    }
    return body;
  }

  /**
   * The conflict the last save stopped on, or `undefined`. Set only when a
   * save was refused because the remote moved; cleared by answering it.
   */
  pendingConflict(): SaveConflictError | undefined {
    return this.conflict_;
  }

  /**
   * Leave the conflict unanswered: keep the paint, save nothing.
   *
   * The safe default, and the action Escape and the backdrop resolve to. The
   * region stays dirty, so the user can keep editing and try again — by which
   * point a merge (or a colleague finishing) may make the conflict moot.
   */
  dismissConflict(): void {
    if (this.conflict_ === undefined) return;
    this.conflict_ = undefined;
    this.changed.dispatch();
  }

  /**
   * Answer the conflict by writing anyway, replacing whatever landed after
   * this session read the region.
   *
   * Irreversible: painting layers carry no object versioning, so the bytes
   * this replaces cannot be recovered. Only ever reached from an explicit
   * confirmation.
   */
  async overwriteConflict(
    host: EditSessionHost,
    session: EditSession,
  ): Promise<void> {
    if (this.conflict_ === undefined) return;
    // Take the recoverable copy BEFORE the irreversible write, and let a
    // failure to take it stop the write. The user agreed to overwrite with a
    // safety net; proceeding without one silently would be answering a
    // question they were not asked. The conflict stays pending so the dialog
    // is still there to try again or back out.
    try {
      await host.snapshotDraft("before-overwrite");
    } catch (error) {
      this.applyGlobalFailure(
        "Couldn't save a local copy of your work first, so nothing was " +
          "overwritten. " +
          (error instanceof Error ? error.message : String(error)),
      );
      this.changed.dispatch();
      return;
    }
    this.conflict_ = undefined;
    await this.startSave(host, session, "overwrite");
  }

  /**
   * Answer the conflict by folding the remote's changes into the overlay,
   * then saving the combined result.
   *
   * The save that follows carries `"just-merged"` and skips the scan, because
   * the payload it sends already incorporates the remote the merge folded in —
   * a scan would only re-report the divergence that merge resolved.
   *
   * Nothing durable is advanced to make that true, which is the point: undoing
   * the merge leaves no residue, so the NEXT save scans from the original
   * baseline and refuses exactly as it did before. The narrow window between
   * the merge and this save is covered by the read-back verification every
   * save ends in.
   */
  async mergeConflict(
    host: EditSessionHost,
    session: EditSession,
  ): Promise<MergeConflictsOutcome | undefined> {
    const conflict = this.conflict_;
    if (conflict === undefined) return undefined;
    let outcome: MergeConflictsOutcome;
    try {
      outcome = await host.mergeConflicts(conflict.scan);
    } catch (error) {
      // The conflict is cleared only once the merge has actually happened.
      // Clearing first would close the dialog on a merge that then threw,
      // leaving the user with dirty paint, no conflict shown, and a Save
      // button that just raises the same conflict again with no explanation.
      this.applyGlobalFailure(
        "Couldn't combine the other changes, so nothing was saved. " +
          (error instanceof Error ? error.message : String(error)),
      );
      this.changed.dispatch();
      return undefined;
    }
    this.conflict_ = undefined;
    this.changed.dispatch();
    // Scoped to this one save: the payload already incorporates the remote, so
    // a scan would only re-report the divergence the merge just resolved. Any
    // LATER save scans normally — which is what makes undoing a merge safe.
    await this.startSave(host, session, "just-merged");
    return outcome;
  }

  /**
   * Whether this conflict should be combined without asking.
   *
   * Only when the user configured `"combine"` AND every conflicting chunk can
   * actually be merged. A chunk the scan could not prove has no baseline, so
   * there is no third input to merge from — auto-combining "as much as
   * possible" and writing the rest would quietly overwrite exactly the chunks
   * we were least sure about. Those fall back to asking.
   */
  private shouldCombineAutomatically(
    host: EditSessionHost,
    conflict: SaveConflictError,
  ): boolean {
    if (conflictStrategyOf(host.editPreferences.value.value) !== "combine") {
      return false;
    }
    return (
      conflict.scan.uncomparable.length === 0 &&
      conflict.scan.diverged.length > 0
    );
  }

  async startSave(
    host: EditSessionHost,
    session: EditSession,
    conflictPolicy: SaveConflictPolicy = "refuse",
  ): Promise<void> {
    if (this.state_.kind === "saving") return;
    if (!session.dirty.isDirty()) return;

    const controller = new AbortController();
    this.state_ = { kind: "saving", controller };
    this.saveStartedAt_ = Date.now();
    this.markAllWritablePending();
    this.changed.dispatch();

    let result: SaveResult | undefined;
    let thrownError: unknown;
    try {
      result = await host.saveActive(
        undefined,
        controller.signal,
        conflictPolicy,
      );
    } catch (err) {
      thrownError = err;
    }

    if (isSaveConflictError(thrownError)) {
      // Not a failure: nothing was attempted and nothing was lost. The save
      // stops and waits on a decision, so the state goes back to idle rather
      // than painting the layers red — the paint is still dirty and still
      // saveable once the user answers.
      this.conflict_ = thrownError;
      this.state_ = { kind: "idle" };
      // Per-layer statuses are left as `startSave` set them (pending): the
      // refused save touched nothing, so there is no per-layer outcome to show.
      this.changed.dispatch();
      if (this.shouldCombineAutomatically(host, thrownError)) {
        await this.mergeConflict(host, session);
      }
      return;
    }

    if (thrownError !== undefined) {
      const message =
        thrownError instanceof Error
          ? thrownError.message
          : String(thrownError);
      this.applyGlobalFailure(message);
      this.changed.dispatch();
      return;
    }

    if (result === undefined) return;
    // The write may report `succeeded` while read-back verification has NOT yet
    // confirmed the bytes are durable (TM-352). In that case the save is NOT
    // done — surface a persistent failure (kept until a successful re-save)
    // instead of a green "saved", so the user knows their data is unconfirmed.
    if (host.hasUnconfirmedSaves()) {
      this.applyGlobalFailure(
        "Your changes were sent but couldn't be confirmed as saved. " +
          "They're kept here and not lost.",
      );
    } else {
      this.applySaveResult(result);
    }
    this.changed.dispatch();
  }

  /**
   * Re-save the chunks a previous save couldn't confirm (TM-352). Drives the
   * SAME `saving` state machine as {@link startSave} — so the Save button shows
   * the spinner (and can be cancelled) during the retry, then returns to active
   * (still unconfirmed) or clears (now confirmed).
   */
  async retry(host: EditSessionHost): Promise<void> {
    if (this.state_.kind === "saving") return;
    if (!host.hasUnconfirmedSaves()) return;

    const controller = new AbortController();
    this.state_ = { kind: "saving", controller };
    this.saveStartedAt_ = Date.now();
    this.changed.dispatch();

    let thrownError: unknown;
    try {
      await host.retryUnconfirmedSaves(controller.signal);
    } catch (err) {
      thrownError = err;
    }

    if (thrownError !== undefined) {
      this.applyGlobalFailure(
        thrownError instanceof Error
          ? thrownError.message
          : String(thrownError),
      );
      this.changed.dispatch();
      return;
    }

    if (host.hasUnconfirmedSaves()) {
      this.applyGlobalFailure(
        "Your changes were sent but couldn't be confirmed as saved. " +
          "They're kept here and not lost.",
      );
    } else {
      const savedAt = Date.now();
      this.state_ = { kind: "done-success", savedAt };
      this.scheduleAutoClear(savedAt);
    }
    this.changed.dispatch();
  }

  cancel(host: EditSessionHost): void {
    if (this.state_.kind !== "saving") return;
    try {
      this.state_.controller.abort();
    } catch {
      // Aborting an already-settled controller can throw; nothing to recover.
    }
    host.cancelActiveSave();
  }

  dispose(): void {
    if (this.autoClearTimer_ !== undefined) {
      clearTimeout(this.autoClearTimer_);
      this.autoClearTimer_ = undefined;
    }
  }

  private markAllWritablePending(): void {
    const next = new Map(this.layerStatuses_);
    for (const [key, entry] of next) {
      if (!entry.writable) continue;
      next.set(key, { ...entry, status: "pending", detail: "saving…" });
    }
    this.layerStatuses_ = next;
  }

  private applyGlobalFailure(message: string): void {
    const failedIds: string[] = [];
    const next = new Map(this.layerStatuses_);
    for (const [key, entry] of next) {
      if (!entry.writable) continue;
      next.set(key, {
        layerId: entry.layerId,
        writable: true,
        status: "failed",
        detail: message,
      });
      failedIds.push(key);
    }
    this.layerStatuses_ = next;
    this.state_ = { kind: "done-partial", failedLayers: failedIds };
  }

  private applySaveResult(result: SaveResult): void {
    const failedLayers: string[] = [];
    const next = new Map(this.layerStatuses_);
    for (const outcome of result.outcomes) {
      const existing = next.get(outcome.layerId as string);
      const writable = existing?.writable ?? true;
      const status = statusFromOutcome(outcome);
      const detail = detailFromOutcome(outcome, this.saveStartedAt_);
      next.set(outcome.layerId as string, {
        layerId: outcome.layerId,
        writable,
        status,
        detail,
      });
      if (status === "failed") {
        failedLayers.push(outcome.layerId as string);
      }
    }
    this.layerStatuses_ = next;

    if (result.overall === "all-succeeded" && failedLayers.length === 0) {
      const savedAt = Date.now();
      this.state_ = { kind: "done-success", savedAt };
      this.scheduleAutoClear(savedAt);
      return;
    }

    this.state_ = { kind: "done-partial", failedLayers: failedLayers.slice() };
  }

  private scheduleAutoClear(savedAt: number): void {
    if (this.autoClearTimer_ !== undefined) {
      clearTimeout(this.autoClearTimer_);
    }
    this.autoClearTimer_ = setTimeout(() => {
      this.autoClearTimer_ = undefined;
      this.state_ = { kind: "idle", lastSavedAt: savedAt };
      this.changed.dispatch();
    }, 3000);
  }
}

function initializeLayerStatuses(
  host: EditSessionHost,
  session: EditSession,
): Map<string, PerLayerSaveStatus> {
  const statuses = new Map<string, PerLayerSaveStatus>();
  const intent = host.state.value.value;
  const writableByLayer = new Map<string, boolean>();
  if (intent !== null) {
    for (const layer of intent.layers) {
      writableByLayer.set(layer.layerId, layer.writable);
    }
  }
  for (const sel of session.config.layers) {
    const writable = writableByLayer.get(sel.layerId) ?? true;
    if (!writable) {
      statuses.set(sel.layerId as string, {
        layerId: sel.layerId,
        writable,
        status: "skipped",
        detail: "read-only; not saved",
      });
    } else {
      statuses.set(sel.layerId as string, {
        layerId: sel.layerId,
        writable,
        status: "pending",
        detail: "no save yet",
      });
    }
  }
  return statuses;
}

function statusFromOutcome(
  outcome: SaveLayerOutcome,
): PerLayerSaveStatus["status"] {
  if (outcome.status === "succeeded") return "succeeded";
  const code = outcome.error?.code;
  if (code === "save-partial") return "partial";
  if (code === "save-skipped") return "skipped";
  return "failed";
}

function detailFromOutcome(
  outcome: SaveLayerOutcome,
  saveStartedAt: number,
): string {
  if (outcome.status === "succeeded") {
    const seconds = ((Date.now() - saveStartedAt) / 1000).toFixed(1);
    return `succeeded (${seconds}s)`;
  }
  return outcome.error?.message ?? "failed";
}
