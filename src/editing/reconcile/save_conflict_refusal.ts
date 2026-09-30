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
 * moved again. Re-scanning on the retry means "overwrite" overwrites what is
 * actually there now, and a conflict that appeared in the meantime is caught
 * rather than silently included in the blast radius.
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
   * Skip the scan and write regardless — the user was shown the conflict and
   * chose to overwrite. Only ever set from an explicit user decision, never as
   * a fallback: painting layers have no object versioning, so what this
   * overwrites cannot be recovered.
   */
  | "overwrite"
  /**
   * Skip the scan because the overlay was just merged against the remote, so
   * the payload already incorporates it and a scan would only re-report the
   * divergence the merge resolved.
   *
   * Distinct from `"overwrite"` on purpose. They behave alike — neither
   * scans — but they mean opposite things: one knowingly destroys work, the
   * other has just preserved it. Keeping them apart stops the draft-taking
   * and the messaging that hang off an overwrite from ever attaching to a
   * merge, and keeps the intent readable at the call site.
   *
   * Valid only for the save a merge issues immediately. Any later save runs a
   * full scan again, which is what makes undoing a merge safe: nothing
   * durable was advanced, so the next scan still sees the original baseline
   * and still refuses.
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
