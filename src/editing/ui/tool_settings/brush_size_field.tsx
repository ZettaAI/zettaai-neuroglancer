/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  brushSizeAtStep,
  BRUSH_SIZE_PRESETS,
  brushSizeStep,
  clampBrushSize,
  MAX_BRUSH_SIZE_STEP,
  MIN_BRUSH_SIZE,
} from "#src/editing/brush_size_presets.js";
import { ParamInput } from "#src/editing/ui/tool_settings/param_input.js";
import { ParamLabel } from "#src/editing/ui/tool_settings/param_label.js";
import "#src/editing/ui/tool_settings/brush_size_field.css";

/** Parse a typed size into a valid brush size, or null if empty/invalid. */
function parseSize(raw: string): number | null {
  const parsed = Number(raw);
  return raw.trim() !== "" && Number.isFinite(parsed)
    ? clampBrushSize(parsed)
    : null;
}

/**
 * The "Size" parameter row, shared by the Brush and Eraser panels: a
 * logarithmic slider over the preset size ladder, plus the exact numeric value.
 *
 * The slider's travel is one step per rung of {@link BRUSH_SIZE_PRESETS}
 * (`brushSizeStep`), which is geometric — so size grows exponentially along the
 * track and the small brushes, where a voxel or two changes the stroke
 * completely, get as much of it as the huge ones. Every rung is drawn as a tick
 * beneath the rail, so the stops are visible and the compression is legible; a
 * keyboard arrow or a `+` / `-` hotkey moves exactly one tick.
 *
 * The number box is the escape hatch for exact values: it accepts any whole size,
 * including ones between rungs. The slider then shows the nearest rung — dragging
 * it snaps, matching the hotkeys.
 */
export function BrushSizeField({
  size,
  hint,
  onCommit,
  highlighted = false,
  onSelect,
}: {
  /** Committed brush diameter in voxels. */
  size: number;
  hint: string;
  onCommit: (size: number) => void;
  /** Outline the row when it is the keyboard-selected parameter. */
  highlighted?: boolean;
  /** Focus this row's parameter for the Ctrl+Arrow scheme (TM-345). */
  onSelect?: () => void;
}) {
  // The slider commits live as it's dragged (direct manipulation); the number
  // box uses the draft pattern and commits on blur / Enter / spinner step.
  const onSlide = (e: Event) =>
    onCommit(
      brushSizeAtStep((e.currentTarget as HTMLInputElement).valueAsNumber),
    );

  return (
    <div
      class={
        "neuroglancer-tool-panel-row" +
        (highlighted ? " neuroglancer-tool-panel-row--selected" : "")
      }
      onPointerDownCapture={onSelect}
      onFocusCapture={onSelect}
    >
      <ParamLabel text="Size" hint={hint} />
      <span class="neuroglancer-brush-size-scale">
        <input
          type="range"
          min={0}
          max={MAX_BRUSH_SIZE_STEP}
          step={1}
          value={brushSizeStep(size)}
          aria-label="Size"
          aria-valuetext={`${size} voxels`}
          onInput={onSlide}
        />
        <span class="neuroglancer-brush-size-ticks" aria-hidden="true">
          {BRUSH_SIZE_PRESETS.map((presetSize, step) => (
            <span
              key={presetSize}
              style={{ left: tickOffset(step) }}
              data-major={isMajorTick(presetSize) ? "true" : undefined}
            />
          ))}
        </span>
      </span>
      <ParamInput<number>
        type="number"
        min={MIN_BRUSH_SIZE}
        step={1}
        value={size}
        parse={parseSize}
        onCommit={onCommit}
      />
    </div>
  );
}

/**
 * Horizontal position of the tick for slider step `step`, aligned to where the
 * thumb centres on that step. A range input's thumb travels between half a thumb
 * width from each end, so the usable track is `100% - 1 thumb` wide — hence the
 * `calc` rather than a plain percentage.
 */
function tickOffset(step: number): string {
  const fraction = MAX_BRUSH_SIZE_STEP === 0 ? 0 : step / MAX_BRUSH_SIZE_STEP;
  return `calc(var(--nge-slider-thumb) / 2 + ${fraction} * (100% - var(--nge-slider-thumb)))`;
}

/**
 * Ticks drawn taller, so the eye can read the scale off the rail instead of
 * counting rungs: the ends, and the rung where single-voxel granularity gives way
 * to doubling.
 */
const MAJOR_TICK_SIZES: readonly number[] = [1, 17, 1025];

function isMajorTick(presetSize: number): boolean {
  return MAJOR_TICK_SIZES.includes(presetSize);
}
