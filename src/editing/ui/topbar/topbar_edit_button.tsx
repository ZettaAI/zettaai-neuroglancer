/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Pencil } from "lucide-preact";
import { useCallback, useEffect, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { ConfirmDialog } from "#src/editing/ui/confirm_dialog.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { SessionEntryModal } from "#src/editing/ui/session_entry/session_entry.js";
import { StatusMessage } from "#src/status.js";

import "#src/editing/ui/topbar/editing_topbar.css";

const SAVING_EXIT_REASON = "Can't exit while saving…";

/**
 * Why NG's own UI may not leave the active session right now, or `undefined`
 * when it may. The embedding host's exit lock takes precedence over an
 * in-flight save: the save ends by itself, the lock does not.
 */
function exitBlockedReason(
  exitLockReason: string | undefined,
  isSaving: boolean,
): string | undefined {
  return exitLockReason ?? (isSaving ? SAVING_EXIT_REASON : undefined);
}

/**
 * Right-most control in the editing topbar: opens the entry modal when no
 * session is active; doubles as the "Exit session" button when one is.
 *
 * Exiting is blocked, with the reason as the button's tooltip, while a save is
 * in flight or while the embedding host has locked exit via
 * `host.lockExit()` (the lock's reason wins). Both gates are re-checked when
 * the button or the discard confirmation is clicked, and a lock that engages
 * while the confirmation is open closes it. The lock gates exit only: with no
 * session the "Edit" button and the entry modal work as usual.
 *
 * Modal lifecycle follows Contract 1 of TM-294/TM-295: this component owns
 * `open` state and renders `<SessionEntryModal open onClose host>` from
 * TM-295. The modal handles its own portal and dismiss.
 */
export function TopbarEditButton({ host }: { host: EditSessionHost }) {
  const sessionOrUndefined = useWatchable(host.activeSession);
  const isActive = sessionOrUndefined !== undefined;
  // Block exiting while a save is in flight: leaving would abort it. The Save
  // button (in ActiveTopbarControls) is the place to cancel a save on purpose.
  const isSaving = useWatchable(host.saveInProgress);
  // Block exiting while the embedding host (the portal) keeps the user in the
  // session, e.g. until a painting task is completed.
  const exitLockReason = useWatchable(host.exitLockReason);
  const blockedReason = isActive
    ? exitBlockedReason(exitLockReason, isSaving)
    : undefined;
  const exitDisabled = blockedReason !== undefined;

  const [open, setOpen] = useState(false);
  const [preselectBboxKey, setPreselectBboxKey] = useState<string | undefined>(
    undefined,
  );
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);

  // The quick edit-region flow (TM-290) draws a box, then asks the topbar to
  // open the modal pre-selected on that box.
  useEffect(
    () =>
      host.requestSessionEntry.add((key?: string) => {
        setPreselectBboxKey(key);
        setOpen(true);
      }),
    [host],
  );

  // A lock that engages while the discard confirmation is open must not leave
  // "Discard and exit" one click away.
  useEffect(() => {
    if (confirmExitOpen && exitLockReason !== undefined) {
      setConfirmExitOpen(false);
    }
  }, [confirmExitOpen, exitLockReason]);

  const discardActive = useCallback(async () => {
    try {
      await host.discardActive();
    } catch (err) {
      StatusMessage.showTemporaryMessage(
        `Failed to exit session: ${err instanceof Error ? err.message : String(err)}`,
        5000,
      );
    }
  }, [host]);

  // Read at action time rather than from the render snapshot: the button's
  // `disabled` reflects the last render, and the confirmation can outlive the
  // state it was opened under (e.g. the portal starts a save while it is open).
  const isExitBlockedNow = useCallback(
    () =>
      exitBlockedReason(
        host.exitLockReason.value,
        host.saveInProgress.value,
      ) !== undefined,
    [host],
  );

  const handleClick = useCallback(() => {
    if (!isActive) {
      setOpen(true);
      return;
    }
    if (isExitBlockedNow()) return;
    // Read dirty state at click time, not render time — this component
    // doesn't subscribe to `session.dirty` events, so a render-time
    // snapshot would be stale once the user starts painting.
    const session = host.activeSession.value;
    if (session === undefined) return;
    // Confirm exit on live dirty edits, in-memory committed patches, OR saves
    // that were sent but not yet confirmed durable (TM-352) — leaving with
    // unconfirmed saves risks silent data loss.
    const dirty =
      session.dirty.isDirty() ||
      host.hasPendingCommittedChanges() ||
      host.hasUnconfirmedSaves();
    if (dirty) {
      setConfirmExitOpen(true);
      return;
    }
    void discardActive();
  }, [isActive, isExitBlockedNow, host, discardActive]);

  return (
    <>
      {/* The wrapper carries the tooltip so the reason still shows while the
          button is disabled: a disabled button emits no pointer events, so the
          CSS drops it to pointer-events:none and hover falls through to this
          span. It sizes to the button and stays the topbar's first flex child,
          so the button's X coordinate does not move. */}
      <span
        class="neuroglancer-editing-topbar-edit-button-wrap"
        data-tooltip={
          blockedReason ??
          (isActive ? "Exit edit session" : "Open the edit-session entry modal")
        }
      >
        <button
          type="button"
          class={
            "neuroglancer-editing-topbar-edit-button" +
            (isActive ? " active" : "")
          }
          disabled={exitDisabled}
          onClick={handleClick}
        >
          <Pencil size={16} aria-hidden="true" />
          {isActive ? "Exit session" : "Edit"}
        </button>
      </span>
      <SessionEntryModal
        open={open}
        onClose={() => {
          setOpen(false);
          setPreselectBboxKey(undefined);
        }}
        host={host}
        preselectBboxKey={preselectBboxKey}
      />
      <ConfirmDialog
        open={confirmExitOpen}
        title="Exit edit session?"
        message="You have unsaved changes. Exiting now will discard them."
        confirmLabel="Discard and exit"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          setConfirmExitOpen(false);
          if (isExitBlockedNow()) return;
          void discardActive();
        }}
        onCancel={() => setConfirmExitOpen(false)}
      />
    </>
  );
}
