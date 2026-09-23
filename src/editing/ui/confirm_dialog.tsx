/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { createPortal } from "preact/compat";
import { useEffect, useRef } from "preact/hooks";

import { useModalDialog } from "#src/editing/ui/interop/use_modal_dialog.js";

// Load the shared --nge-* design tokens (declared on :root) so the portaled
// dialog resolves them even when no tool panel/topbar happens to be mounted.
import "#src/editing/ui/editing_theme.css";
import "#src/editing/ui/confirm_dialog.css";

const TITLE_ID = "neuroglancer-confirm-dialog-title";
const MESSAGE_ID = "neuroglancer-confirm-dialog-message";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** Primary action label. Use verb + object, e.g. "Discard and exit". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Tints the confirm button as a destructive action. */
  destructive?: boolean;
  /**
   * Extra answers, rendered between Cancel and the primary — for a decision
   * with more than one real answer besides the primary. Omitted, the dialog
   * is an ordinary confirm/cancel pair.
   */
  secondaryActions?: readonly ConfirmDialogAction[];
  /**
   * Render no cancel BUTTON, for a decision whose real answers already fill
   * the row, or for a dialog that only has to be acknowledged.
   *
   * `onCancel` still runs on Escape and on a backdrop click, so walking away
   * stays reachable and stays the thing that changes nothing — it just stops
   * occupying a slot. Never hide the cancel button unless every visible
   * action is one the user could reasonably want; it is the only affordance
   * that is guaranteed safe.
   */
  hideCancelButton?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface ConfirmDialogAction {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onClick: () => void;
}

/**
 * Styled replacement for `window.confirm`, matching the edit-session modal's
 * visual vocabulary. Renders nothing when closed; mounts its own portal so it
 * sits above the viewer regardless of where it's used.
 *
 * The cancel (safe) action is first in the DOM, so the focus trap autofocuses
 * it — Escape and the default focused control both resolve to "don't do the
 * destructive thing". When `hideCancelButton` drops that button, focus moves
 * to the primary instead, and Escape still resolves to `onCancel`.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  return createPortal(<ConfirmDialogBody {...props} />, document.body);
}

function ConfirmDialogBody({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  secondaryActions,
  hideCancelButton = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useModalDialog({ active: true, containerRef: dialogRef, onClose: onCancel });

  // `useModalDialog` autofocuses the first control, which is normally the safe
  // Cancel. With no Cancel rendered the first control is a real answer — and
  // with `secondaryActions` the leftmost one can be destructive — so move
  // focus to the primary instead. Declared after `useModalDialog` so this runs
  // after its autofocus rather than being undone by it.
  useEffect(() => {
    if (hideCancelButton) confirmRef.current?.focus();
  }, [hideCancelButton]);

  const confirmClass = [
    "neuroglancer-confirm-dialog-btn",
    "neuroglancer-confirm-dialog-btn-primary",
    destructive ? "neuroglancer-confirm-dialog-btn-destructive" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const secondaryClass = (action: ConfirmDialogAction) =>
    [
      "neuroglancer-confirm-dialog-btn",
      action.destructive === true
        ? "neuroglancer-confirm-dialog-btn-destructive"
        : "",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <div class="neuroglancer-confirm-dialog-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        class="neuroglancer-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={MESSAGE_ID}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div id={TITLE_ID} class="neuroglancer-confirm-dialog-title">
          {title}
        </div>
        <div id={MESSAGE_ID} class="neuroglancer-confirm-dialog-message">
          {message}
        </div>
        <div class="neuroglancer-confirm-dialog-actions">
          {!hideCancelButton && (
            <button
              type="button"
              class="neuroglancer-confirm-dialog-btn"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          )}
          {secondaryActions?.map((action) => (
            <button
              key={action.label}
              type="button"
              class={secondaryClass(action)}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
          <button
            ref={confirmRef}
            type="button"
            class={confirmClass}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
