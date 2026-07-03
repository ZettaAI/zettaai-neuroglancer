/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Link2 } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type {
  AlignmentLinkController,
  AlignmentLinkStatus,
} from "#src/alignment_link/alignment_link_controller.js";
import type { AlignmentModel } from "#src/alignment_link/alignment_link_math.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { ToggleSwitch } from "#src/editing/ui/toggle_switch.js";

import "#src/alignment_link/ui/alignment_link.css";

const MODELS: Array<{ value: AlignmentModel; label: string }> = [
  { value: "local", label: "Local affine (auto)" },
  { value: "translation", label: "Translation" },
  { value: "similarity", label: "Similarity" },
  { value: "affine", label: "Affine" },
];

function statusText(status: AlignmentLinkStatus): {
  text: string;
  tone: "muted" | "warn" | "error";
} {
  if (!status.enabled) {
    return { text: "Off — views move independently", tone: "muted" };
  }
  if (status.error !== undefined) {
    return { text: status.error, tone: "error" };
  }
  if (status.lineCount === 0) {
    return { text: "waiting for alignment lines", tone: "muted" };
  }
  if (status.directionPending) {
    return {
      text: "direction pending — move both views onto a matching feature, or swap manually",
      tone: "warn",
    };
  }
  const rotation =
    status.rotationDeg !== undefined && Math.abs(status.rotationDeg) >= 0.05
      ? ` · ${status.rotationDeg.toFixed(1)}°`
      : "";
  const mirrored = status.mirrored ? " · mirrored" : "";
  return {
    text: `${status.fitMode ?? "?"} · ${status.lineCount} line${
      status.lineCount === 1 ? "" : "s"
    } · ${status.annotationLayerName ?? "?"}${rotation}${mirrored}`,
    tone: "muted",
  };
}

/**
 * Topbar button + settings popover for the annotation-linked view sync.
 * Follows the editing topbar's Edit-button pattern: a small labeled button in
 * the neuroglancer top row; the settings (enable, transform model, direction
 * swap) live in a popover so nothing occupies viewport space during regular
 * work.
 */
export function AlignmentLinkTopbarButton({
  controller,
}: {
  controller: AlignmentLinkController;
}) {
  const status = useWatchable(controller.status);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const line = statusText(status);

  return (
    <div class="neuroglancer-alignment-link" ref={rootRef}>
      <button
        type="button"
        class={
          "neuroglancer-alignment-link-button" +
          (status.enabled ? " active" : "")
        }
        data-tooltip="Link side-by-side views via alignment line annotations"
        onClick={() => setOpen(!open)}
      >
        <Link2 size={16} aria-hidden="true" />
        Align
      </button>
      {open && (
        <div class="neuroglancer-alignment-link-popover">
          <div class="neuroglancer-alignment-link-row">
            <span>Link views via annotations</span>
            <ToggleSwitch
              checked={status.enabled}
              ariaLabel="Link views via annotations"
              onChange={(checked) => controller.setEnabled(checked)}
            />
          </div>
          <label class="neuroglancer-alignment-link-row">
            <span>Transform</span>
            <select
              value={status.model}
              disabled={!status.enabled}
              onChange={(event) =>
                controller.setModel(
                  (event.target as HTMLSelectElement).value as AlignmentModel,
                )
              }
            >
              {MODELS.map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            class="neuroglancer-alignment-link-swap"
            disabled={!status.enabled}
            data-tooltip="Flip which line endpoint belongs to which view"
            onClick={() => controller.swapDirection()}
          >
            ⇄ Swap direction
          </button>
          <div
            class={`neuroglancer-alignment-link-status neuroglancer-alignment-link-status-${line.tone}`}
          >
            {line.text}
          </div>
        </div>
      )}
    </div>
  );
}
