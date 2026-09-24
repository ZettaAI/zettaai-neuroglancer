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
import { automergeEnabled } from "#src/editing/tooling/edit_preferences.js";
import { NullarySignal } from "#src/util/signal.js";

export type SaveAllState =
  | { kind: "idle"; lastSavedAt?: number }
  | { kind: "saving"; controller: AbortController }
  /**
   * Reconciling a refused save against the remote, before the save that
   * follows it. Its own state because the reconcile is network I/O the user
   * can paint through, and reporting `idle` across it let a second Save start
   * from the pre-reconcile overlay.
   */
  | { kind: "reconciling" }
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
  /**
   * Chunks the last save gave back to the remote, discarding local edits.
   * Read once the save settles, to tell the user what reconciling cost them.
   */
  private reloadedChunks_ = 0;

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
   * How many chunks the last save reconciled by DROPPING local edits, zero if
   * none. A count rather than a sentence: the wording belongs with the rest of
   * the annotator-facing copy, not in the state machine.
   */
  reloadedChunkCount(): number {
    return this.reloadedChunks_;
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
    // Dispatch before the save, not after it: `startSave` returns without
    // dispatching when another save is already in flight, which would leave
    // the dialog rendered against a conflict that no longer exists and every
    // one of its buttons a no-op.
    this.changed.dispatch();
    await this.startSave(host, session, "overwrite");
  }

  /**
   * Answer the conflict by reconciling the overlay against the remote, then
   * saving the result.
   *
   * "Reconcile" rather than "merge" because it is not all one thing: chunks
   * the two sides changed in different places are combined and keep every
   * local edit, while a chunk they both changed in the SAME place cannot be
   * combined and is given back to the remote whole — the local edits in it
   * are dropped. {@link reloadedChunkCount} is how many, and the caller is
   * expected to tell the user.
   *
   * The save that follows carries `"just-merged"` and skips the scan, because
   * the payload it sends already incorporates the remote it reconciled
   * against — a scan would only re-report the divergence just resolved.
   *
   * Nothing durable is advanced to make that true, which is the point: undoing
   * the reconcile leaves no residue, so the NEXT save scans from the original
   * baseline and refuses exactly as it did before. The narrow window between
   * the reconcile and this save is covered by the read-back verification every
   * save ends in.
   */
  async mergeConflict(
    host: EditSessionHost,
    session: EditSession,
  ): Promise<MergeConflictsOutcome | undefined> {
    const conflict = this.conflict_;
    if (conflict === undefined) return undefined;
    return this.reconcileAndSave(host, session, conflict);
  }

  /**
   * Reconcile against the remote and save the result.
   *
   * Takes the conflict as an argument rather than reading `conflict_`, which
   * is what lets the automatic path run it WITHOUT ever publishing the
   * conflict — see {@link startSave}. On failure it publishes the conflict:
   * an automerge that could not complete has to become the dialog, never
   * silence.
   */
  private async reconcileAndSave(
    host: EditSessionHost,
    session: EditSession,
    conflict: SaveConflictError,
  ): Promise<MergeConflictsOutcome | undefined> {
    let outcome: MergeConflictsOutcome;
    // Cancel any stale timer from a prior save: if we are here, that save's
    // done-success state has been subsumed by this new conflict and reconcile,
    // and we must not let the timer fire during the reconcile and stomp the
    // reconciling state back to idle.
    if (this.autoClearTimer_ !== undefined) {
      clearTimeout(this.autoClearTimer_);
      this.autoClearTimer_ = undefined;
    }
    // Claimed before the first await, so there is no window in which a second
    // Save can start from the pre-reconcile overlay.
    this.state_ = { kind: "reconciling" };
    this.changed.dispatch();
    try {
      outcome = await host.mergeConflicts(conflict.scan);
    } catch (error) {
      // The conflict is cleared only once the merge has actually happened.
      // Clearing first would close the dialog on a merge that then threw,
      // leaving the user with dirty paint, no conflict shown, and a Save
      // button that just raises the same conflict again with no explanation.
      this.conflict_ = conflict;
      // `applyGlobalFailure` leaves a terminal state, so the reconciling claim
      // is released by it rather than needing a reset here.
      this.applyGlobalFailure(
        "Couldn't combine the other changes, so nothing was saved. " +
          (error instanceof Error ? error.message : String(error)),
      );
      this.changed.dispatch();
      return undefined;
    }
    this.conflict_ = undefined;
    // Released so the save below can claim `saving`; nothing can slip in
    // between, because there is no await between here and `startSave`.
    this.state_ = { kind: "idle" };
    this.changed.dispatch();
    // Scoped to this one save: the payload already incorporates the remote, so
    // a scan would only re-report the divergence the merge just resolved. Any
    // LATER save scans normally — which is what makes undoing a merge safe.
    await this.startSave(host, session, "just-merged");
    this.recordDiscard(outcome.reloadedChunks);
    // TODO(TM-xxx): Clear the undo history when we discard chunks, so the
    // user cannot accidentally undo the reload decision and reapply work that
    // was discarded due to a collision. Currently no public API in
    // @zettaai/edit-session — needs a clear() method on EditSession.
    return outcome;
  }

  /**
   * Publish what reconciling cost, once the save that paid for it has settled.
   *
   * Recorded when the save succeeded, or when it's unconfirmed (couldn't verify
   * — but the write did land). NOT recorded when the save failed outright,
   * because a failure has its own message and the discard is not the headline.
   *
   * Added rather than assigned because a follow-up save can itself refuse and
   * reconcile again; two rounds of discarded work are two rounds, and the user
   * should be told about both.
   */
  private recordDiscard(chunks: number): void {
    if (chunks === 0) return;
    if (this.state_.kind === "done-success") {
      this.reloadedChunks_ += chunks;
      this.changed.dispatch();
      return;
    }
    // done-partial can be either a failed save or an unconfirmed save. Only
    // record the discard if it's unconfirmed (the message mentions "confirmed").
    if (this.state_.kind === "done-partial") {
      const message = this.lastFailureMessage();
      if (message !== undefined && message.includes("confirmed")) {
        this.reloadedChunks_ += chunks;
        this.changed.dispatch();
      }
    }
  }

  /**
   * Answer the conflict by taking the remote's version of every chunk it
   * names, dropping the local edits in them, then saving what is left.
   *
   * Unlike a merge this needs no baseline, so it also covers the chunks the
   * scan could not prove — which is the point: a refusal made entirely of
   * unprovable chunks otherwise leaves the user choosing between overwriting
   * a colleague and never saving.
   *
   * The save that follows is an ORDINARY scanning one, not `"just-merged"`.
   * After a reload the remote already holds what those chunks would write, so
   * the scan calls them `already-applied` and lets the rest of the work
   * through — while a chunk whose remote could NOT be read still carries our
   * stale bytes and is still caught. Skipping the scan here would write
   * exactly those blind.
   */
  async reloadConflict(
    host: EditSessionHost,
    session: EditSession,
  ): Promise<void> {
    const conflict = this.conflict_;
    if (conflict === undefined) return;
    let reloaded: number;
    this.state_ = { kind: "reconciling" };
    this.changed.dispatch();
    try {
      reloaded = (await host.reloadConflictedChunks(conflict.scan))
        .reloadedChunks;
    } catch (error) {
      // Same reasoning as the reconcile path: the conflict stays pending so
      // the dialog is still there rather than leaving dirty paint with no
      // explanation for why Save keeps refusing.
      this.applyGlobalFailure(
        "Couldn't load the other changes, so nothing was saved. " +
          (error instanceof Error ? error.message : String(error)),
      );
      this.changed.dispatch();
      return;
    }
    this.conflict_ = undefined;
    this.state_ = { kind: "idle" };
    this.changed.dispatch();
    await this.startSave(host, session, "refuse");
    this.recordDiscard(reloaded);
    // TODO(TM-xxx): Clear the undo history when we reload chunks from the
    // remote, so the user cannot accidentally undo the reload decision and
    // reapply work that was discarded due to a conflict. Currently no public
    // API in @zettaai/edit-session — needs a clear() method on EditSession.
  }

  /**
   * Whether this conflict may be answered without asking.
   *
   * Only when automerge is on AND every conflicting chunk can actually be
   * reconciled. A chunk the scan could not prove has no baseline, so there is
   * no third input to merge from — reconciling "as much as possible" and
   * writing the rest would quietly overwrite exactly the chunks we were least
   * sure about. Those fall back to asking, which is the one case where Save
   * still raises the dialog with automerge on.
   *
   * Note this deliberately does NOT auto-reload the unprovable ones, even
   * though {@link reloadConflict} could. `uncomparable` is not evidence of a
   * conflict — the likeliest state of a chunk whose baseline was evicted is
   * that nobody touched it — so discarding an hour of tracing over our own
   * bookkeeping is not a trade to make on the user's behalf. Offered as a
   * button, yes; taken automatically, no.
   */
  private shouldReconcileAutomatically(
    host: EditSessionHost,
    conflict: SaveConflictError,
  ): boolean {
    if (!automergeEnabled(host.editPreferences.value.value)) {
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
    if (this.state_.kind === "saving" || this.state_.kind === "reconciling") {
      return;
    }
    if (!session.dirty.isDirty()) return;

    const controller = new AbortController();
    this.state_ = { kind: "saving", controller };
    this.saveStartedAt_ = Date.now();
    this.reloadedChunks_ = 0;
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
      //
      // DECIDE BEFORE PUBLISHING. The dialog is open exactly while
      // `pendingConflict()` is set, so assigning the conflict and dispatching
      // before asking whether to answer it automatically made the dialog mount
      // and unmount within a couple of frames — a pop-up that appears and
      // vanishes, which reads as a glitch rather than as an answer. The
      // invariant that replaces it: never dispatch with `conflict_` set until
      // it is known the user has to be asked.
      if (this.shouldReconcileAutomatically(host, thrownError)) {
        // `reconcileAndSave` claims `reconciling` synchronously, so the Save
        // button keeps its spinner instead of flicking to idle and back.
        await this.reconcileAndSave(host, session, thrownError);
        return;
      }
      this.state_ = { kind: "idle" };
      this.conflict_ = thrownError;
      // Per-layer statuses are left as `startSave` set them (pending): the
      // refused save touched nothing, so there is no per-layer outcome to show.
      this.changed.dispatch();
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
      let message =
        "Your changes were sent but couldn't be confirmed as saved. " +
        "They're kept here and not lost.";
      if (this.reloadedChunks_ > 0) {
        message =
          `Your edits in ${this.reloadedChunks_ === 1 ? "1 area were" : `${this.reloadedChunks_} areas were`} ` +
          "discarded and reloaded, but the rest were sent. They couldn't be " +
          "confirmed as saved — please review your data once verification completes.";
      }
      this.applyGlobalFailure(message);
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
