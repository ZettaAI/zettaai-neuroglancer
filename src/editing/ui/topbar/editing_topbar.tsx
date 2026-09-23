/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/editing_theme.css";
import "#src/editing/ui/topbar/editing_topbar.css";

import type { EditSession } from "@zettaai/edit-session";
import type { LucideIcon } from "lucide-preact";
import {
  Eraser,
  GitMerge,
  Layers,
  Loader2,
  LocateFixed,
  MousePointer2,
  PaintBucket,
  Paintbrush,
  Redo2,
  Save,
  Undo2,
} from "lucide-preact";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import {
  formatKeyIdentifier,
  keyboardEventToIdentifier,
} from "#src/editing/keybind_event.js";
import type { SaveConflictError } from "#src/editing/reconcile/save_conflict_refusal.js";
import {
  effectiveEditKeybinds,
  type EditKeybindName,
} from "#src/editing/session_hotkey_binder.js";
import { automergeEnabled } from "#src/editing/tooling/edit_preferences.js";
import { ConfirmDialog } from "#src/editing/ui/confirm_dialog.js";
import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { SaveTracker } from "#src/editing/ui/session_controls/save_tracker.js";
import { ChunkLoadProgress } from "#src/editing/ui/topbar/chunk_load_progress.js";
import { TopbarEditButton } from "#src/editing/ui/topbar/topbar_edit_button.js";
import { StatusMessage } from "#src/status.js";

// Synthetic tool id used for the "Cursor" row. Selecting it clears the active
// tool (no real library tool corresponds to it). Mirrors the legacy
// `tool_list.tsx` convention; kept here so deletion of the old session-controls
// root doesn't strand the constant.
export const CURSOR_TOOL_ID = "cursor";

/** Pixel size for all topbar Lucide icons — consistent across the toolbar. */
const TOOL_ICON_SIZE = 17;

interface ToolEntry {
  readonly toolId: string;
  readonly label: string;
  /** The configurable keybind action this tool's button rebinds. */
  readonly keybind: EditKeybindName;
  /**
   * Lucide icon component rendered as the button's glyph. Icons inherit the
   * button's `color` via `stroke="currentColor"`, so all visual states
   * (rest / hover / active / disabled) are driven by CSS — never by swapping
   * the icon. The label and shortcut remain exposed via `title`/`aria-label`.
   */
  readonly Icon: LucideIcon;
  readonly markDisabled?: boolean;
}

const TOOL_ENTRIES: readonly ToolEntry[] = [
  {
    toolId: CURSOR_TOOL_ID,
    label: "Cursor",
    keybind: "cursor",
    Icon: MousePointer2,
  },
  {
    toolId: "painting.brush",
    label: "Brush",
    keybind: "brush",
    Icon: Paintbrush,
  },
  { toolId: "painting.erase", label: "Eraser", keybind: "erase", Icon: Eraser },
  {
    toolId: "painting.fill",
    label: "Fill",
    keybind: "fill",
    Icon: PaintBucket,
  },
  {
    toolId: "z-extrapolation",
    label: "Z-extrapolation",
    keybind: "zextrap",
    Icon: Layers,
  },
];

export function EditingTopbar({ host }: { host: EditSessionHost }) {
  const session = useWatchable(host.activeSession);
  // The Edit / Exit button is the only flex child of the topbar — that
  // keeps its X coordinate identical between idle and active states (the
  // topbar's natural width never changes). Active-session controls are
  // rendered into an absolutely-positioned trailing wrapper anchored to
  // the right edge of the Edit button; viewer.ts centers the topbar
  // between two flex:1 spacers so the cluster sits at the visual center
  // of the neuroglancer top row.
  return (
    <div class="neuroglancer-editing-topbar">
      <TopbarEditButton host={host} />
      {session !== undefined && (
        <div class="neuroglancer-editing-topbar-trailing">
          <ActiveTopbarControls host={host} session={session} />
        </div>
      )}
    </div>
  );
}

/** "1 area" / "4 areas" — the annotator-facing unit for a conflicting chunk. */
function areaCount(count: number): string {
  return count === 1 ? "1 area" : `${count} areas`;
}

/**
 * The refused save, in the annotator's terms.
 *
 * Counts areas rather than listing chunk ids on purpose: "0,1,3" names nothing
 * a tracer can act on, and the decision does not turn on WHICH chunks moved —
 * only on how much moved and what overwriting costs.
 */
function describeSaveConflict(conflict: SaveConflictError | undefined): string {
  if (conflict === undefined) return "";
  const { diverged, uncomparable } = conflict.scan;
  const sentences: string[] = [];
  if (diverged.length > 0) {
    sentences.push(
      `${areaCount(diverged.length)} you painted changed after you loaded ` +
        "the region.",
    );
  }
  if (uncomparable.length > 0) {
    sentences.push(`${areaCount(uncomparable.length)} couldn't be checked.`);
  }
  sentences.push(
    "Merge keeps both sides, except where you both changed the same voxels — " +
      "those areas are reloaded and your edits in them are dropped.",
  );
  sentences.push(
    "Reload takes their version of every area listed. Overwrite replaces " +
      "their work permanently — these layers keep no history, so it can't be " +
      "undone.",
  );
  sentences.push("Press Esc to leave everything as it is.");
  return sentences.join(" ");
}

/**
 * What a save that reconciled itself cost the user, said plainly.
 *
 * Shown after the save, not before: this is the one outcome where work was
 * destroyed without anyone choosing it, so it names the amount, points at the
 * data, and names the way back.
 */
function describeConflictReload(count: number): string {
  const those = count === 1 ? "that area was" : "those areas were";
  return (
    `Your edits in ${areaCount(count)} were discarded: you and someone else ` +
    `changed the same voxels there, so ${those} reloaded from storage. ` +
    "Everything else was saved. Please review your data — one undo puts your " +
    "version back."
  );
}

function ActiveTopbarControls({
  host,
  session,
}: {
  host: EditSessionHost;
  session: EditSession;
}) {
  // Lazily construct + dispose a SaveTracker. The old session-controls panel
  // owned this; now the topbar does. A single tracker per active session
  // keeps the unsaved-count badge and Save-all controls coherent.
  const saveTrackerRef = useRef<SaveTracker | undefined>(undefined);
  if (saveTrackerRef.current === undefined) {
    saveTrackerRef.current = new SaveTracker(host, session);
  }
  const saveTracker = saveTrackerRef.current;
  useEffect(() => () => saveTracker.dispose(), [saveTracker]);

  // Force a re-render on tool / history / dirty changes — the underlying
  // session is a mutable bag and Preact has no way to know to re-render.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const unsubs = [
      // Active-tool selection is consumer-owned on the host (TM-315).
      host.activeToolId.changed.add(() => bump(0)),
      // The tool registry is built asynchronously after the session opens; this
      // re-renders once it lands (and when it's torn down) so the tool buttons
      // appear/disappear with it.
      host.toolingChanged.add(() => bump(0)),
      session.on("history-changed", () => bump(0)),
      session.dirty.on("dirty-changed", () => bump(0)),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [session, host]);
  useSignal(saveTracker.changed);

  // Registry-driven: which toolbar buttons are enabled comes from the tools
  // actually registered for this session (TM-315), not a hardcoded list.
  // Computed inline (not memoized) so each `toolingChanged` bump re-reads the
  // registry — it does not exist yet on the first render after session-open.
  const knownToolIds = new Set(host.toolRegistry?.ids() ?? []);
  const activeToolId = host.activeToolId.value;
  const snapshot = session.getHistory();
  const hasDirty = session.dirty.isDirty();
  const saveAvailable = useWatchable(host.saveBackendAvailable);
  // Reconciling counts as saving for the button: it is network work the
  // save is waiting on, and showing idle there invites a second click.
  const isSaving =
    saveTracker.state.kind === "saving" ||
    saveTracker.state.kind === "reconciling";
  // Granular save+verify progress (TM-352). Drives the save-progress messages,
  // and keeps the Save button CLICKABLE while there are unconfirmed saves so the
  // user can re-save (its label/badge are intentionally left unchanged — we
  // don't repurpose a user-important control to display verification state).
  const saveProgress = useWatchable(host.saveProgress);
  const hasUnconfirmed = host.hasUnconfirmedSaves();
  // Set only while a refused save waits on a decision; `useSignal` above
  // re-renders when the tracker records or clears it.
  const pendingConflict = saveTracker.pendingConflict();
  const confirmOverwrite = useCallback(() => {
    void saveTracker.overwriteConflict(host, session);
  }, [saveTracker, host, session]);
  // Set when a settled save reconciled by discarding local edits. Held in
  // state rather than read from the tracker at render time because it has to
  // survive until the user acknowledges it, not until the next re-render.
  const [reloadNotice, setReloadNotice] = useState<string | undefined>(
    undefined,
  );
  // Everything a settled save still owes the user. Both toasts are failures;
  // a discard is not a failure, so it gets a dialog it has to be dismissed.
  const reportSaveOutcome = useCallback(() => {
    const failure = saveTracker.lastFailureMessage();
    if (failure !== undefined) {
      StatusMessage.showTemporaryMessage(failure, 10000);
    }
    const reloaded = saveTracker.reloadedChunkCount();
    if (reloaded > 0) setReloadNotice(describeConflictReload(reloaded));
  }, [saveTracker]);
  const confirmMerge = useCallback(() => {
    void (async () => {
      await saveTracker.mergeConflict(host, session);
      reportSaveOutcome();
    })();
  }, [saveTracker, host, session, reportSaveOutcome]);
  const confirmReload = useCallback(() => {
    void (async () => {
      await saveTracker.reloadConflict(host, session);
      reportSaveOutcome();
    })();
  }, [saveTracker, host, session, reportSaveOutcome]);
  const automerge = automergeEnabled(useWatchable(host.editPreferences.value));
  const toggleAutomerge = useCallback(() => {
    host.setAutomerge(!automerge);
  }, [host, automerge]);
  // A merge needs all three inputs; a chunk the scan could not prove has no
  // baseline to merge from, so offering it would promise something we cannot
  // deliver for part of the save.
  const canMergeConflict =
    pendingConflict !== undefined &&
    pendingConflict.scan.uncomparable.length === 0 &&
    pendingConflict.scan.diverged.length > 0;

  // Distinct layers with saved-but-unconfirmed chunks. Read inline (cheap) so
  // it stays in sync with `hasUnconfirmed`; the component already re-renders on
  // `saveProgress` / SaveTracker changes, which is when this count moves.
  const unconfirmedLayers = host.unconfirmedLayerCount();

  // Number of layers with changes to save/verify, shown as the Save-button
  // badge. We approximate the dirty case using the SaveTracker statuses
  // (writable layers in non-succeeded state count as pending). When nothing is
  // dirty but a previous save couldn't be confirmed, fall back to the
  // unconfirmed-layer count — an active Save button must always show a matching
  // counter (TM-352), since those chunks were rebaselined and no longer read as
  // dirty.
  const pendingCount = useMemo(() => {
    let count = 0;
    for (const entry of saveTracker.layerStatuses.values()) {
      if (!entry.writable) continue;
      if (entry.status === "succeeded") continue;
      count += 1;
    }
    if (hasDirty) return count > 0 ? count : 1;
    if (hasUnconfirmed) return unconfirmedLayers > 0 ? unconfirmedLayers : 1;
    return 0;
  }, [hasDirty, hasUnconfirmed, unconfirmedLayers, saveTracker.layerStatuses]);

  const handleToolClick = useCallback(
    (toolId: string) => {
      try {
        if (toolId === CURSOR_TOOL_ID) {
          host.selectTool(undefined);
          return;
        }
        if (toolId === activeToolId) {
          // Re-clicking the active tool's icon toggles only that tool's
          // panel — the active tool stays selected so the icon remains
          // highlighted. Matches the X-close behavior on the panel itself.
          host.toggleToolPanel(toolId);
          return;
        }
        host.selectTool(toolId);
      } catch (err) {
        StatusMessage.showTemporaryMessage(
          err instanceof Error ? err.message : String(err),
          4000,
        );
      }
    },
    [host, activeToolId],
  );

  // -- Runtime hotkey rebinding (TM-315) ----------------------------------
  // The effective binding per action (defaults ← custom-keybinds.json ←
  // per-user overrides). Recomputed whenever the user rebinds.
  const overrides = useWatchable(host.editKeybindOverrides);
  const effective = useMemo(
    () => effectiveEditKeybinds(overrides),
    [overrides],
  );
  const hotkeyLabel = useCallback(
    (name: EditKeybindName): string => {
      const keys = effective[name];
      return keys.length > 0 ? formatKeyIdentifier(keys[0]) : "unbound";
    },
    [effective],
  );

  // The action currently awaiting a key-capture, or null when not rebinding.
  const [capturing, setCapturing] = useState<EditKeybindName | null>(null);
  useEffect(() => {
    if (capturing === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Swallow the keypress so it neither triggers a session hotkey nor types
      // into anything while we are capturing.
      event.preventDefault();
      event.stopPropagation();
      // Escape cancels the capture without binding.
      if (event.code === "Escape") {
        setCapturing(null);
        return;
      }
      const identifier = keyboardEventToIdentifier(event);
      if (identifier === undefined) return; // lone modifier — keep waiting
      host.setEditKeybind(capturing, [identifier]);
      setCapturing(null);
      StatusMessage.showTemporaryMessage(
        `Bound "${capturing}" to ${formatKeyIdentifier(identifier)}`,
        2500,
      );
    };
    // Capture phase so we intercept before the session-scoped action map.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [capturing, host]);

  const startRebind = useCallback((name: EditKeybindName, event: Event) => {
    // Right-click (or the dedicated affordance) — never open the browser
    // context menu here.
    event.preventDefault();
    setCapturing(name);
    StatusMessage.showTemporaryMessage(
      `Press a key combination for "${name}" — Esc to cancel`,
      4000,
    );
  }, []);

  const runUndo = useCallback(async () => {
    try {
      await session.undo();
    } catch (err) {
      StatusMessage.showTemporaryMessage(
        err instanceof Error ? err.message : String(err),
        3000,
      );
    }
  }, [session]);

  const runRedo = useCallback(async () => {
    try {
      await session.redo();
    } catch (err) {
      StatusMessage.showTemporaryMessage(
        err instanceof Error ? err.message : String(err),
        3000,
      );
    }
  }, [session]);

  const runSaveAll = useCallback(() => {
    void (async () => {
      await saveTracker.startSave(host, session);
      // Surface a failed/unconfirmed save as a prominent toast — the per-layer
      // status is otherwise only visible in the panel, so without this the user
      // gets no clear signal that their changes did not reach the server. With
      // automerge on this also covers the reconcile, because `startSave` runs
      // it and the follow-up save before it resolves.
      reportSaveOutcome();
    })();
  }, [saveTracker, host, session, reportSaveOutcome]);

  const teleportToRegion = useCallback(() => {
    if (!host.teleportToActiveRegionCenter()) {
      StatusMessage.showTemporaryMessage("No active edit region", 3000);
    }
  }, [host]);

  const cancelSave = useCallback(() => {
    saveTracker.cancel(host);
  }, [saveTracker, host]);

  // Re-save the chunks a previous save couldn't confirm (TM-352). Routes through
  // the same SaveTracker state machine as a normal save, so the button shows the
  // spinner / can be cancelled during the retry.
  const runRetry = useCallback(() => {
    void (async () => {
      await saveTracker.retry(host);
      const failure = saveTracker.lastFailureMessage();
      if (failure !== undefined) {
        StatusMessage.showTemporaryMessage(failure, 10000);
      }
    })();
  }, [saveTracker, host]);

  // Case 1 — requests still in flight (write / first read-back not yet
  // answered): only reassure after a while, since this is the slow-connection
  // case. Reset the timer whenever the phase changes.
  const inFlight =
    saveProgress.kind === "writing" || saveProgress.kind === "verifying";
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => {
      StatusMessage.showTemporaryMessage(
        "Still saving your changes… this can take a while on a slow connection.",
        8000,
      );
    }, 20000);
    return () => clearInterval(id);
  }, [inFlight]);

  // Case 2 — the request DID answer but the change isn't verified yet, so we're
  // retrying. Tell the user immediately on each additional attempt (this is NOT
  // a slow connection — the data just hasn't been confirmed).
  const reverifyAttempt =
    saveProgress.kind === "reverifying" ? saveProgress.attempt : 0;
  useEffect(() => {
    if (reverifyAttempt === 0) return;
    StatusMessage.showTemporaryMessage(
      "Your changes were sent but aren't confirmed yet — re-checking… " +
        `(attempt ${reverifyAttempt})`,
      8000,
    );
  }, [reverifyAttempt]);

  return (
    <>
      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="Save"
      >
        {/*
          One fixed-geometry button across every state. A constant-size leading
          icon slot swaps its glyph (Save → spinner) without resizing, and the
          button reserves a stable width (see `min-width` in the stylesheet) so
          the "Saving…" label never widens the box and shoves the toolbar. The
          badge is position:absolute, so it stays out of the width entirely.
        */}
        <button
          type="button"
          class={
            "neuroglancer-editing-topbar-save-button" +
            (isSaving ? " saving" : "")
          }
          disabled={
            !isSaving && (!saveAvailable || (!hasDirty && !hasUnconfirmed))
          }
          data-tooltip={
            isSaving
              ? "Saving changes… click to cancel"
              : saveAvailable
                ? "Save all dirty layers to the backend"
                : "Saving is unavailable — no save backend is registered."
          }
          aria-label={isSaving ? "Saving changes — click to cancel" : undefined}
          onClick={isSaving ? cancelSave : hasDirty ? runSaveAll : runRetry}
        >
          {isSaving ? (
            <Loader2
              size={14}
              class="neuroglancer-editing-topbar-save-icon neuroglancer-editing-topbar-spinner"
              aria-hidden="true"
            />
          ) : (
            <Save
              size={14}
              class="neuroglancer-editing-topbar-save-icon"
              aria-hidden="true"
            />
          )}
          <span class="neuroglancer-editing-topbar-save-label">
            {isSaving ? "Saving…" : "Save all"}
          </span>
          {!isSaving && pendingCount > 0 && (
            <span class="neuroglancer-editing-topbar-badge">
              {pendingCount}
            </span>
          )}
        </button>
        {/*
          Sits with Save because it changes what Save DOES, and it is the only
          way a tracer can reach the setting — it otherwise lives in the URL.
        */}
        <button
          type="button"
          class={
            "neuroglancer-editing-topbar-icon-button" +
            (automerge ? " active" : "")
          }
          aria-label="Combine conflicting edits automatically"
          aria-pressed={automerge}
          data-tooltip={
            automerge
              ? "Conflicts are combined automatically when you save"
              : "Conflicts stop the save and ask you what to do"
          }
          onClick={toggleAutomerge}
        >
          <GitMerge size={TOOL_ICON_SIZE} aria-hidden="true" />
        </button>
      </div>

      <div class="neuroglancer-editing-topbar-divider" />

      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="Editing tools"
      >
        {TOOL_ENTRIES.filter(
          (entry) =>
            entry.toolId === CURSOR_TOOL_ID || knownToolIds.has(entry.toolId),
        ).map((entry) => {
          const isActive =
            entry.toolId === CURSOR_TOOL_ID
              ? activeToolId === undefined
              : entry.toolId === activeToolId;
          const { Icon } = entry;
          const isCapturing = capturing === entry.keybind;
          const keyLabel = hotkeyLabel(entry.keybind);
          return (
            <button
              key={entry.toolId}
              type="button"
              class={
                "neuroglancer-editing-topbar-tool" +
                (isActive ? " active" : "") +
                (isCapturing ? " capturing" : "") +
                (entry.markDisabled ? " disabled" : "")
              }
              data-tooltip={
                isCapturing
                  ? `Press a key for ${entry.label} · Esc to cancel`
                  : `${entry.label} · ${keyLabel}\nRight-click to rebind`
              }
              aria-label={`${entry.label} (${keyLabel})`}
              onClick={() => handleToolClick(entry.toolId)}
              onContextMenu={(e) => startRebind(entry.keybind, e)}
            >
              <Icon size={TOOL_ICON_SIZE} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div class="neuroglancer-editing-topbar-divider" />

      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="View"
      >
        <button
          type="button"
          class="neuroglancer-editing-topbar-icon-button"
          aria-label="Center view on edit region"
          data-tooltip="Center view on edit region"
          onClick={teleportToRegion}
        >
          <LocateFixed size={TOOL_ICON_SIZE} aria-hidden="true" />
        </button>
      </div>

      <div class="neuroglancer-editing-topbar-divider" />

      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="History"
      >
        <button
          type="button"
          class={
            "neuroglancer-editing-topbar-icon-button" +
            (capturing === "undo" ? " capturing" : "")
          }
          disabled={!snapshot.canUndo}
          aria-label={`Undo (${hotkeyLabel("undo")})`}
          data-tooltip={
            capturing === "undo"
              ? "Press a key for Undo · Esc to cancel"
              : `Undo · ${hotkeyLabel("undo")}\nRight-click to rebind${snapshot.undoDescription ? `\n${snapshot.undoDescription}` : ""}`
          }
          onClick={() => void runUndo()}
          onContextMenu={(e) => startRebind("undo", e)}
        >
          <Undo2 size={TOOL_ICON_SIZE} aria-hidden="true" />
        </button>
        <button
          type="button"
          class={
            "neuroglancer-editing-topbar-icon-button" +
            (capturing === "redo" ? " capturing" : "")
          }
          disabled={!snapshot.canRedo}
          aria-label={`Redo (${hotkeyLabel("redo")})`}
          data-tooltip={
            capturing === "redo"
              ? "Press a key for Redo · Esc to cancel"
              : `Redo · ${hotkeyLabel("redo")}\nRight-click to rebind${snapshot.redoDescription ? `\n${snapshot.redoDescription}` : ""}`
          }
          onClick={() => void runRedo()}
          onContextMenu={(e) => startRebind("redo", e)}
        >
          <Redo2 size={TOOL_ICON_SIZE} aria-hidden="true" />
        </button>
      </div>

      {/*
        Transient region-preload status lives at the trailing edge so that when
        it appears (session open) and disappears (load done) it extends into the
        empty right-edge space rather than shoving Save / tools / Undo-Redo. It
        renders nothing while idle and after a clean load — only the persistent
        "N chunks unavailable" warning lingers.
      */}
      <ChunkLoadProgress host={host} />

      {/*
        Raised when a save was refused because the region moved under this
        session. Destructive-tinted, and the safe action is the default: with
        no object versioning on painting layers, overwriting cannot be undone.

        Three real answers fill the button row, so the way out is Esc and the
        backdrop rather than a fourth button — `onCancel` still changes
        nothing, and focus lands on the primary rather than on Reload.
      */}
      <ConfirmDialog
        open={pendingConflict !== undefined}
        title="Someone else edited this region"
        message={describeSaveConflict(pendingConflict)}
        {...(canMergeConflict
          ? {
              // Merging keeps both sides wherever it can, so it is the primary
              // and is not tinted destructive; overwriting is the one that
              // destroys someone else's work outright.
              confirmLabel: "Merge",
              onConfirm: confirmMerge,
              secondaryActions: [
                { label: "Reload", onClick: confirmReload },
                {
                  label: "Overwrite",
                  destructive: true,
                  onClick: confirmOverwrite,
                },
              ],
            }
          : {
              // Nothing to merge from — an unprovable chunk has no baseline.
              // Reload still works, because it needs only their bytes, so it
              // becomes the primary: the safe answer stays the default one.
              confirmLabel: "Reload",
              onConfirm: confirmReload,
              secondaryActions: [
                {
                  label: "Overwrite",
                  destructive: true,
                  onClick: confirmOverwrite,
                },
              ],
            })}
        hideCancelButton
        onCancel={() => saveTracker.dismissConflict()}
      />
      {/*
        A save that reconciled itself discarded some of the user's paint
        without asking. That cannot be a toast: it is the one outcome where
        work was destroyed by a default, so it has to be acknowledged.
      */}
      <ConfirmDialog
        open={reloadNotice !== undefined}
        title="Some of your edits were discarded"
        message={reloadNotice ?? ""}
        confirmLabel="OK"
        hideCancelButton
        onConfirm={() => setReloadNotice(undefined)}
        onCancel={() => setReloadNotice(undefined)}
      />
    </>
  );
}
