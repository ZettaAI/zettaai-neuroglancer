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
 * The keys of Trace and split error detection. They live apart from `frontend.ts`
 * so the Trace tab can read them without importing it, and show exactly what the
 * maps bind instead of a second, hand-written copy.
 */

import { chordsForAction } from "#src/ui/key_chord_format.js";
import type { ModeShortcut } from "#src/ui/mode_shortcuts.js";
import { EventActionMap } from "#src/util/event_action_map.js";

export const TRACE_KEYS_MODE = "trace";
export const AIM_KEYS_MODE = "trace-aim";
export const SPLIT_DETECTION_KEYS_MODE = "split-detection";

// Bound straight to a key like the debug toggle: both are modes that must
// survive the proofreader picking up a tool.
export const CALCADA_TRACE_TOGGLE_ACTION = "calcada-toggle-zetta-trace";
// A mode like the other two, bound straight to a key for the same reason.
export const CALCADA_SPLIT_DETECTION_TOGGLE_ACTION =
  "calcada-toggle-split-detection";

function plusMinusBindings(mode: string) {
  const plus = { action: `${mode}-plus` };
  const minus = { action: `${mode}-minus` };
  return {
    // The shifted key comes first because it is the one shown: "+", not "=".
    "at:shift+equal": plus,
    "at:equal": plus,
    "at:numpadadd": plus,
    "at:minus": minus,
    "at:numpadsubtract": minus,
  };
}

export const ZETTA_TRACE_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:arrowleft": { action: "reject-candidate" },
  "at:arrowright": { action: "accept-candidate" },
  "at:arrowdown": { action: "skip-candidate" },
  "at:arrowup": { action: "trace-end-back" },
  // Its own action name, not the shared "undo": the merge and cut tools listen
  // for that one on window, and a keypress resolving to it would run their
  // handler and this one both — two reverts from a single press.
  "at:control+keyz": { action: "trace-undo" },
  "at:meta+keyz": { action: "trace-undo" },
  "at:escape": { action: "exit-trace" },
  ...plusMinusBindings(TRACE_KEYS_MODE),
});

// Held only while the sights are up. The placing click is bound HERE and
// nowhere else on purpose: during a trace a click has to stay an ordinary
// click, because a proofreader checking a candidate selects neighbouring
// segments to look at, and that must not move the trace.
export const CALCADA_TRACE_AIM_INPUT_EVENT_MAP = EventActionMap.fromObject({
  ...plusMinusBindings(AIM_KEYS_MODE),
  // Ctrl, not a plain click: in the 3D panel a bare drag orbits the camera, and
  // aiming is exactly when you want to keep turning the view to find the spot.
  // Cmd too, as a Mac may turn Ctrl+click into a context menu.
  "at:control+mousedown0": { action: "trace-place-sphere" },
  "at:meta+mousedown0": { action: "trace-place-sphere" },
  "at:escape": { action: "trace-cancel-aim" },
});

// Held only while split error detection is on.
export const SPLIT_DETECTION_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:arrowleft": { action: "split-detection-previous" },
  "at:arrowright": { action: "split-detection-next" },
  ...plusMinusBindings(SPLIT_DETECTION_KEYS_MODE),
});

// Ctrl like the trace's sphere, so a plain click stays a click.
export const PROOFREAD_SEGMENT_PICK_INPUT_EVENT_MAP = EventActionMap.fromObject(
  {
    "at:control+mousedown0": { action: "proofread-segment-pick" },
    "at:meta+mousedown0": { action: "proofread-segment-pick" },
  },
);

export const traceChords = (action: string) =>
  chordsForAction(ZETTA_TRACE_INPUT_EVENT_MAP, action);
export const splitDetectionChords = (action: string) =>
  chordsForAction(SPLIT_DETECTION_INPUT_EVENT_MAP, action);

const aimChords = (action: string) =>
  chordsForAction(CALCADA_TRACE_AIM_INPUT_EVENT_MAP, action);

export const TRACE_MODE_SHORTCUTS: readonly ModeShortcut[] = [
  { keys: traceChords("accept-candidate"), label: "Accept" },
  { keys: traceChords("reject-candidate"), label: "Reject" },
  { keys: traceChords("skip-candidate"), label: "Skip" },
  {
    keys: traceChords(`${TRACE_KEYS_MODE}-minus`),
    pairKeys: traceChords(`${TRACE_KEYS_MODE}-plus`),
    label: "Lowest score",
  },
  { keys: traceChords("trace-undo"), label: "Undo" },
  { keys: traceChords("exit-trace"), label: "Exit" },
];

export const TRACE_END_MODE_SHORTCUTS: readonly ModeShortcut[] = [
  { keys: traceChords("accept-candidate"), label: "Certain end" },
  { keys: traceChords("reject-candidate"), label: "Uncertain end" },
  { keys: traceChords("skip-candidate"), label: "Look deeper" },
  { keys: traceChords("trace-end-back"), label: "Back" },
  { keys: traceChords("exit-trace"), label: "Close" },
];

export const TRACE_AIM_MODE_SHORTCUTS: readonly ModeShortcut[] = [
  { keys: aimChords("trace-place-sphere"), label: "Place the sphere" },
  {
    keys: aimChords(`${AIM_KEYS_MODE}-minus`),
    pairKeys: aimChords(`${AIM_KEYS_MODE}-plus`),
    label: "Sphere size",
  },
  { keys: aimChords("trace-cancel-aim"), label: "Cancel" },
];

export const SPLIT_DETECTION_MODE_SHORTCUTS: readonly ModeShortcut[] = [
  {
    keys: splitDetectionChords("split-detection-previous"),
    pairKeys: splitDetectionChords("split-detection-next"),
    label: "Previous / next",
  },
  {
    keys: splitDetectionChords(`${SPLIT_DETECTION_KEYS_MODE}-minus`),
    pairKeys: splitDetectionChords(`${SPLIT_DETECTION_KEYS_MODE}-plus`),
    label: "Lowest score",
  },
];
