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
 * @file What a save does when the remote moved under it, and how that refusal
 * reaches the UI.
 *
 * The refusal is raised from `saveActive` BEFORE the library builds its payload,
 * and it ends the save. It is deliberately not a pause: a save holds the host's
 * single in-flight slot (`saveActive` refuses to start a second one), so parking
 * it while a human reads a dialog would block every other save for as long as
 * they take to answer, and hold an `AbortController` and a planned snapshot
 * across that whole window. Ending the save costs one re-plan when the user
 * chooses — the overlay, the dirty flags and the undo history are all still
 * there, because a save that never reached the library changed nothing.
 *
 * Re-planning is also the safer half of the trade. The user's answer is about
 * the conflict they were SHOWN; by the time they answer, the remote may have
 * moved again. Re-planning means the answer is applied against what is actually
 * there now, and a conflict that appeared in the meantime is caught rather than
 * silently included in the blast radius.
 */

import type { StaleBaselineScan } from "#src/editing/reconcile/stale_baseline_scan.js";

/**
 * What a save should do when the scan finds the remote has moved.
 *
 * There is no `"merge"` member: a pixel-level combine is applied to the overlay
 * through the session's write protocol BEFORE a save is started, so by the time
 * a save runs the merged bytes are simply the bytes to write, and the save that
 * follows is an ordinary `"refuse"` one.
 */
export type SaveConflictPolicy =
  /** Default. Scan first; refuse the save if anything diverged or is unproven. */
  | "refuse"
  /**
   * Skip the scan because the overlay was just reconciled against the remote,
   * so the payload already incorporates it and a scan would only re-report the
   * divergence the reconcile resolved.
   *
   * There used to be an `"overwrite"` beside this, which skipped the scan and
   * wrote this session's bytes wholesale. It is gone because wholesale was the
   * wrong unit: the owned box it sent carried the session's start-up baseline
   * for every voxel the user never painted, so answering a conflict with it
   * resurrected work a colleague had deleted in the meantime. Both answers
   * that keep the user's work now reconcile, differing only in who wins a
   * voxel both sides changed, and both arrive here.
   *
   * Valid only for the save a reconcile issues immediately. Any later save runs
   * a full scan again, which is what makes undoing a reconcile safe: nothing
   * durable was advanced, so the next scan still sees the original baseline and
   * still refuses.
   */
  | "just-merged";

/**
 * Raised instead of writing when the scan finds this save would clobber work
 * that landed after this session read the region.
 *
 * Carries the whole scan rather than a message so the UI can list what
 * diverged, and can distinguish that from chunks it could not prove either way.
 */
export class SaveConflictError extends Error {
  override readonly name = "SaveConflictError";
  constructor(readonly scan: StaleBaselineScan) {
    super(describeRefusal(scan));
  }
}

export function isSaveConflictError(
  error: unknown,
): error is SaveConflictError {
  return error instanceof SaveConflictError;
}

/**
 * Whether a scan should stop the save.
 *
 * Unproven chunks stop it too. "We could not tell" is not "nothing happened":
 * the retained baseline a comparison needs is held in a bounded store, so the
 * unprovable case is reachable in exactly the large sessions where an
 * overwrite costs the most. Treating it as clean would restore the silent
 * overwrite the scan exists to prevent.
 */
export function refusesSave(scan: StaleBaselineScan): boolean {
  return scan.diverged.length > 0 || scan.uncomparable.length > 0;
}

/**
 * Whether a refusal can be answered by combining.
 *
 * A combine needs all three inputs, and a chunk the scan could not prove has
 * no baseline to combine from — so one unprovable chunk takes the option away
 * from the whole save. Both the dialog's button row and the text it explains
 * itself with read this, so the two cannot drift apart.
 */
export function canCombine(scan: StaleBaselineScan): boolean {
  return scan.diverged.length > 0 && scan.uncomparable.length === 0;
}

function describeRefusal(scan: StaleBaselineScan): string {
  const parts: string[] = [];
  if (scan.diverged.length > 0) {
    parts.push(`${scan.diverged.length} changed since this session read them`);
  }
  if (scan.uncomparable.length > 0) {
    parts.push(`${scan.uncomparable.length} could not be checked`);
  }
  return `refusing to save: ${parts.join(", ")}`;
}
